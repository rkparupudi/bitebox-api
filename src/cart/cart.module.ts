import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Put,
  Query,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import Redis from 'ioredis';
import { In, Repository } from 'typeorm';
import { REDIS } from '../common/redis.module';
import { AuthUser, CurrentUser, Role, Roles } from '../common/roles';
import { MenuItem, Restaurant } from '../restaurants/restaurant.entities';
import { RestaurantsModule } from '../restaurants/restaurants.module';

export class SetCartItemDto {
  @IsUUID() menuItemId: string;
  /** 0 removes the line. */
  @IsInt() @Min(0) @Max(50) quantity: number;
}

/**
 * What Redis stores: only ids and quantities. Prices and names are looked up from
 * Postgres every time the cart is read, so a client can never set its own price and
 * a menu price change shows up immediately.
 */
interface StoredCart {
  restaurantId: string;
  lines: Record<string, number>; // menuItemId -> quantity
}

export interface ResolvedCartLine {
  menuItemId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  isAvailable: boolean;
}

export interface ResolvedCart {
  restaurantId: string | null;
  restaurant: Pick<Restaurant, 'id' | 'name' | 'isOpen' | 'isActive'> | null;
  lines: ResolvedCartLine[];
  subtotalMinor: number;
}

const CART_TTL_SECONDS = 60 * 60 * 24;
const cartKey = (userId: string) => `cart:${userId}`;
const EMPTY: ResolvedCart = { restaurantId: null, restaurant: null, lines: [], subtotalMinor: 0 };

@Injectable()
export class CartService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @InjectRepository(MenuItem) private readonly items: Repository<MenuItem>,
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
  ) {}

  async get(userId: string): Promise<ResolvedCart> {
    const stored = await this.read(userId);
    if (!stored) return EMPTY;

    const ids = Object.keys(stored.lines);
    const [restaurant, items] = await Promise.all([
      this.restaurants.findOne({ where: { id: stored.restaurantId } }),
      this.items.find({ where: { id: In(ids), restaurantId: stored.restaurantId } }),
    ]);
    if (!restaurant) {
      await this.clear(userId);
      return EMPTY;
    }

    // Items deleted from the menu since they were added simply drop out of the cart.
    const lines = items.map((item) => {
      const quantity = stored.lines[item.id];
      return {
        menuItemId: item.id,
        name: item.name,
        unitPriceMinor: item.priceMinor,
        quantity,
        lineTotalMinor: item.priceMinor * quantity,
        isAvailable: item.isAvailable,
      };
    });
    return {
      restaurantId: restaurant.id,
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        isOpen: restaurant.isOpen,
        isActive: restaurant.isActive,
      },
      lines,
      subtotalMinor: lines.reduce((sum, l) => sum + l.lineTotalMinor, 0),
    };
  }

  /**
   * A cart holds items from one restaurant only. Adding from a different restaurant is a
   * 409 unless the client passes replace=true (the "start a new cart?" prompt in the app).
   */
  async setItem(userId: string, dto: SetCartItemDto, replace = false): Promise<ResolvedCart> {
    const item = await this.items.findOne({ where: { id: dto.menuItemId } });
    if (!item) throw new NotFoundException('Menu item not found');

    let cart = await this.read(userId);
    if (cart && cart.restaurantId !== item.restaurantId) {
      if (!replace) {
        throw new ConflictException(
          'Your cart has items from another restaurant. Retry with replace=true to start a new cart.',
        );
      }
      cart = null;
    }
    cart ??= { restaurantId: item.restaurantId, lines: {} };

    if (dto.quantity === 0) delete cart.lines[item.id];
    else cart.lines[item.id] = dto.quantity;

    if (Object.keys(cart.lines).length === 0) await this.clear(userId);
    else await this.redis.set(cartKey(userId), JSON.stringify(cart), 'EX', CART_TTL_SECONDS);
    return this.get(userId);
  }

  async clear(userId: string) {
    await this.redis.del(cartKey(userId));
  }

  private async read(userId: string): Promise<StoredCart | null> {
    const raw = await this.redis.get(cartKey(userId));
    return raw ? (JSON.parse(raw) as StoredCart) : null;
  }
}

@Roles(Role.CUSTOMER)
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.cart.get(user.id);
  }

  @Put('items')
  setItem(
    @CurrentUser() user: AuthUser,
    @Body() dto: SetCartItemDto,
    @Query('replace') replace?: string,
  ) {
    return this.cart.setItem(user.id, dto, replace === 'true');
  }

  @Delete()
  @HttpCode(204)
  clear(@CurrentUser() user: AuthUser) {
    return this.cart.clear(user.id);
  }
}

@Module({
  imports: [RestaurantsModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
