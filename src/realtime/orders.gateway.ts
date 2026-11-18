import { Logger, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { AuthUser, Role } from '../common/roles';
import { OrderStatus } from '../orders/order-status';
import { ORDER_STATUS_CHANGED, OrderStatusChanged } from '../orders/orders.service';
import { Restaurant } from '../restaurants/restaurant.entities';
import { RESTAURANT_CREATED } from '../restaurants/restaurants.module';

export const rooms = {
  user: (id: string) => `user:${id}`,
  restaurant: (id: string) => `restaurant:${id}`,
  admins: 'admins',
};

/**
 * Real-time order updates over Socket.IO, namespace /orders.
 *
 * Connect with the same JWT the REST API uses:  io(url + '/orders', { auth: { token } })
 * On connect, the server puts each socket in the rooms it's allowed to hear:
 *   - every user:       user:<their id>          (their own orders)
 *   - restaurant owner: restaurant:<id> for each restaurant they own
 *   - admin:            admins                   (everything)
 * Clients never choose rooms themselves, so nobody can subscribe to someone else's orders.
 *
 * Event pushed: "order.updated" with { orderId, restaurantId, from, status, at }.
 * With the Redis adapter (see app.setup.ts), this works across many API instances.
 */
@WebSocketGateway({ namespace: '/orders', cors: { origin: true } })
export class OrdersGateway implements OnGatewayConnection {
  private readonly logger = new Logger(OrdersGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
  ) {}

  async handleConnection(socket: Socket) {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        socket.handshake.headers.authorization?.replace(/^Bearer /, '');
      if (!token) throw new Error('missing token');
      const payload = this.jwt.verify<{ sub: string; email: string; role: Role }>(token);
      const user: AuthUser = { id: payload.sub, email: payload.email, role: payload.role };
      socket.data.user = user;

      const joins = [rooms.user(user.id)];
      if (user.role === Role.RESTAURANT_OWNER) {
        const owned = await this.restaurants.find({ where: { ownerId: user.id }, select: ['id'] });
        joins.push(...owned.map((r) => rooms.restaurant(r.id)));
      }
      if (user.role === Role.ADMIN) joins.push(rooms.admins);
      await socket.join(joins);
      socket.emit('ready', { rooms: joins });
    } catch (err) {
      this.logger.debug(`Socket rejected: ${(err as Error).message}`);
      socket.emit('error', { message: 'Unauthorized' });
      socket.disconnect(true);
    }
  }

  /**
   * A new restaurant: put all of its owner's open sockets into the restaurant's room.
   * socketsJoin goes through the Redis adapter, so it reaches sockets on every instance.
   */
  @OnEvent(RESTAURANT_CREATED)
  onRestaurantCreated(e: { ownerId: string; restaurantId: string }) {
    this.server.in(rooms.user(e.ownerId)).socketsJoin(rooms.restaurant(e.restaurantId));
  }

  @OnEvent(ORDER_STATUS_CHANGED)
  onStatusChanged(change: OrderStatusChanged) {
    const payload = {
      orderId: change.orderId,
      restaurantId: change.restaurantId,
      from: change.from,
      status: change.status,
      at: change.at,
    };
    let target = this.server.to(rooms.user(change.customerId)).to(rooms.admins);
    // A restaurant first hears about an order when it's paid (PLACED), then every change after.
    // An unpaid order that gets cancelled never reaches the restaurant at all.
    const visibleToRestaurant =
      change.status === OrderStatus.PLACED ||
      (change.from !== null && change.from !== OrderStatus.PENDING_PAYMENT);
    if (visibleToRestaurant) target = target.to(rooms.restaurant(change.restaurantId));
    target.emit('order.updated', payload);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Restaurant])],
  providers: [OrdersGateway],
})
export class RealtimeModule {}
