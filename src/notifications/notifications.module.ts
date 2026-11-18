import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import {
  Column,
  CreateDateColumn,
  Entity,
  In,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Repository,
  UpdateDateColumn,
} from 'typeorm';
import { AuthUser, CurrentUser } from '../common/roles';
import { OrderStatus } from '../orders/order-status';
import { Order } from '../orders/order.entities';
import { ORDER_STATUS_CHANGED, OrderStatusChanged } from '../orders/orders.service';
import { Restaurant } from '../restaurants/restaurant.entities';
import { User } from '../users/user.entity';

/**
 * A phone or tablet that can receive push notifications.
 *
 * The mobile app gets an Expo push token on the device and registers it here after sign-in.
 * Expo's push service then delivers to Google (FCM) on Android and Apple (APNs) on iOS, so
 * the API has one integration for both platforms.
 */
@Entity('devices')
export class Device {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  /** e.g. ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]. Unique: one device, one owner at a time. */
  @Index({ unique: true })
  @Column()
  token: string;

  @Column()
  platform: string; // 'ios' | 'android'

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  lastSeenAt: Date;
}

export class RegisterDeviceDto {
  @IsString()
  @MaxLength(255)
  @Matches(/^(ExponentPushToken|ExpoPushToken)\[.+\]$/, { message: 'token must be an Expo push token' })
  token: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound?: 'default';
  channelId?: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/** What the customer is told at each step. pending_payment is deliberately silent. */
const CUSTOMER_TEXT: Partial<Record<OrderStatus, [string, string]>> = {
  [OrderStatus.PLACED]: ['Order placed', 'Payment received. Waiting for the restaurant to accept.'],
  [OrderStatus.CONFIRMED]: ['Order accepted', 'The restaurant has accepted your order.'],
  [OrderStatus.PREPARING]: ['Being prepared', 'Your food is being cooked.'],
  [OrderStatus.READY_FOR_PICKUP]: ['Ready', 'Your order is packed and ready for pickup.'],
  [OrderStatus.OUT_FOR_DELIVERY]: ['On the way', 'Your order is out for delivery.'],
  [OrderStatus.DELIVERED]: ['Delivered', 'Enjoy your meal!'],
  [OrderStatus.CANCELLED]: ['Order cancelled', 'Your order was cancelled. Any payment will be refunded.'],
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly url: string;
  private readonly accessToken?: string;

  constructor(
    config: ConfigService,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
  ) {
    this.url = config.get<string>('EXPO_PUSH_URL', 'https://exp.host/--/api/v2/push/send');
    this.accessToken = config.get<string>('EXPO_ACCESS_TOKEN') || undefined;
  }

  async sendToUsers(userIds: string[], message: Omit<PushMessage, 'to'>) {
    if (userIds.length === 0) return;
    const devices = await this.devices.find({ where: { userId: In(userIds) } });
    if (devices.length === 0) return;
    await this.send(devices.map((d) => ({ ...message, to: d.token, sound: 'default', channelId: 'orders' })));
  }

  /** Expo accepts up to 100 messages per request. Tokens Expo reports as dead are removed. */
  async send(messages: PushMessage[]) {
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const tickets = await this.post(chunk);
        const dead = chunk.filter((_, idx) => tickets[idx]?.details?.error === 'DeviceNotRegistered').map((m) => m.to);
        if (dead.length) {
          await this.devices.delete({ token: In(dead) });
          this.logger.log(`Removed ${dead.length} unregistered device(s)`);
        }
      } catch (err) {
        // Notifications are best-effort: never let them break an order flow.
        this.logger.warn(`Push send failed: ${(err as Error).message}`);
      }
    }
  }

  /** The HTTP call to Expo. Separate so tests can replace it. */
  protected async post(messages: PushMessage[]): Promise<ExpoTicket[]> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(messages),
    });
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
    const json = (await res.json()) as { data?: ExpoTicket[] };
    return json.data ?? [];
  }
}

/** Turns order events into notifications for the customer and the restaurant owner. */
@Injectable()
export class OrderNotifier {
  constructor(
    private readonly push: PushService,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
  ) {}

  @OnEvent(ORDER_STATUS_CHANGED, { async: true, promisify: true, suppressErrors: true })
  async onStatusChanged(change: OrderStatusChanged) {
    const ref = `#${change.orderId.slice(0, 6).toUpperCase()}`;
    const data = { orderId: change.orderId, restaurantId: change.restaurantId, status: change.status };

    const text = CUSTOMER_TEXT[change.status];
    // A customer who cancels an unpaid order themselves doesn't need telling.
    const silent = change.status === OrderStatus.CANCELLED && change.from === OrderStatus.PENDING_PAYMENT;
    if (text && !silent) {
      await this.push.sendToUsers([change.customerId], { title: `${text[0]} · ${ref}`, body: text[1], data });
    }

    // The restaurant hears about new paid orders and about cancellations of orders it had seen.
    const restaurantCares =
      change.status === OrderStatus.PLACED ||
      (change.status === OrderStatus.CANCELLED && change.from !== OrderStatus.PENDING_PAYMENT);
    if (!restaurantCares) return;
    const restaurant = await this.restaurants.findOne({ where: { id: change.restaurantId }, select: ['id', 'ownerId', 'name'] });
    if (!restaurant) return;
    if (change.status === OrderStatus.PLACED) {
      const order = await this.orders.findOne({ where: { id: change.orderId }, relations: { items: true } });
      const count = order?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;
      await this.push.sendToUsers([restaurant.ownerId], {
        title: `New order ${ref}`,
        body: `${count} item${count === 1 ? '' : 's'} for ${restaurant.name}. Tap to accept.`,
        data,
      });
    } else {
      await this.push.sendToUsers([restaurant.ownerId], {
        title: `Order ${ref} cancelled`,
        body: `An order for ${restaurant.name} was cancelled.`,
        data,
      });
    }
  }
}

@Controller('devices')
export class DevicesController {
  constructor(@InjectRepository(Device) private readonly devices: Repository<Device>) {}

  /**
   * Register (or re-register) this device for the signed-in user. Idempotent: the app calls
   * it on every launch. If the token belonged to another account (someone else signed in on
   * this phone before), it moves to the current user.
   */
  @Post()
  @HttpCode(204)
  async register(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceDto) {
    await this.devices.upsert(
      { token: dto.token, platform: dto.platform, userId: user.id, lastSeenAt: new Date() },
      { conflictPaths: ['token'] },
    );
  }

  /** Called on sign-out so a shared device stops receiving the previous user's notifications. */
  @Delete(':token')
  @HttpCode(204)
  async unregister(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    await this.devices.delete({ token, userId: user.id });
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Device, Order, Restaurant])],
  controllers: [DevicesController],
  providers: [PushService, OrderNotifier],
  exports: [PushService],
})
export class NotificationsModule {}
