import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { CartService } from '../cart/cart.module';
import { AuthUser, Role } from '../common/roles';
import { Payment, PaymentGateway, PaymentStatus } from '../payments/payments.module';
import { Restaurant } from '../restaurants/restaurant.entities';
import { Actor, OrderStatus, RESTAURANT_VISIBLE_STATUSES, canTransition } from './order-status';
import { Order, OrderItem, OrderStatusEvent } from './order.entities';

export const ORDER_STATUS_CHANGED = 'order.status_changed';

export interface OrderStatusChanged {
  orderId: string;
  customerId: string;
  restaurantId: string;
  from: OrderStatus | null;
  status: OrderStatus;
  at: string;
}

export interface CheckoutInput {
  deliveryAddress: string;
  notes?: string;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly currency: string;
  private readonly deliveryFeeMinor: number;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
    private readonly cart: CartService,
    private readonly gateway: PaymentGateway,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.currency = config.get<string>('CURRENCY', 'inr').toLowerCase();
    this.deliveryFeeMinor = Number(config.get('DELIVERY_FEE_MINOR', 4000));
  }

  // ------------------------------------------------------------------ checkout

  /**
   * Turns the customer's cart into an order and a Stripe PaymentIntent.
   * The order starts as PENDING_PAYMENT; only Stripe's webhook can move it to PLACED.
   * The client uses the returned clientSecret with Stripe.js / the mobile SDK to pay.
   */
  async checkout(user: AuthUser, input: CheckoutInput) {
    const cart = await this.cart.get(user.id);
    if (!cart.restaurant || cart.lines.length === 0) throw new BadRequestException('Cart is empty');
    if (!cart.restaurant.isActive || !cart.restaurant.isOpen) {
      throw new ConflictException('This restaurant is not taking orders right now');
    }
    const unavailable = cart.lines.filter((l) => !l.isAvailable);
    if (unavailable.length) {
      throw new ConflictException(
        `No longer available: ${unavailable.map((l) => l.name).join(', ')}. Remove them and try again.`,
      );
    }

    const subtotalMinor = cart.subtotalMinor;
    const totalMinor = subtotalMinor + this.deliveryFeeMinor;

    const order = await this.dataSource.transaction(async (m) => {
      const created = await m.save(
        m.create(Order, {
          customerId: user.id,
          restaurantId: cart.restaurant!.id,
          status: OrderStatus.PENDING_PAYMENT,
          subtotalMinor,
          deliveryFeeMinor: this.deliveryFeeMinor,
          totalMinor,
          currency: this.currency,
          deliveryAddress: input.deliveryAddress,
          notes: input.notes ?? null,
          items: cart.lines.map((l) =>
            m.create(OrderItem, {
              menuItemId: l.menuItemId,
              name: l.name,
              unitPriceMinor: l.unitPriceMinor,
              quantity: l.quantity,
            }),
          ),
        }),
      );
      await m.save(
        m.create(OrderStatusEvent, {
          orderId: created.id,
          fromStatus: null,
          toStatus: OrderStatus.PENDING_PAYMENT,
          actor: 'customer',
          actorUserId: user.id,
        }),
      );
      return created;
    });

    // The Stripe call is outside the DB transaction on purpose: never hold a DB
    // transaction open across a network call to a third party.
    let intent: { id: string; clientSecret: string };
    try {
      intent = await this.gateway.createPaymentIntent({
        orderId: order.id,
        amountMinor: totalMinor,
        currency: this.currency,
        customerEmail: user.email,
      });
    } catch (err) {
      this.logger.error(`PaymentIntent creation failed for order ${order.id}: ${(err as Error).message}`);
      await this.transition(order.id, OrderStatus.CANCELLED, 'system', null, 'payment_setup_failed');
      throw new BadGatewayException('Could not start payment. Your cart is unchanged; please try again.');
    }

    await this.payments.save(
      this.payments.create({
        orderId: order.id,
        providerPaymentId: intent.id,
        amountMinor: totalMinor,
        currency: this.currency,
      }),
    );
    await this.cart.clear(user.id);

    return {
      order: await this.findForUser(user, order.id),
      payment: { provider: 'stripe', paymentIntentId: intent.id, clientSecret: intent.clientSecret },
    };
  }

  /** Lets the app resume paying for an order that is still awaiting payment. */
  async getPaymentSecret(user: AuthUser, orderId: string) {
    const order = await this.findForUser(user, orderId);
    if (order.customerId !== user.id) throw new ForbiddenException();
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException('This order is not awaiting payment');
    }
    const payment = await this.payments.findOneByOrFail({ orderId });
    return {
      provider: 'stripe',
      paymentIntentId: payment.providerPaymentId,
      clientSecret: await this.gateway.getClientSecret(payment.providerPaymentId),
    };
  }

  /**
   * Local development only (PAYMENTS_PROVIDER=fake): pretend Stripe sent a webhook.
   * Builds a Stripe-shaped event and runs it through the real webhook handler, so the
   * code path is identical to production apart from the signature check.
   */
  async simulatePayment(user: AuthUser, orderId: string, outcome: 'succeeded' | 'failed') {
    const order = await this.findForUser(user, orderId);
    if (order.customerId !== user.id) throw new ForbiddenException();
    const payment = await this.payments.findOneByOrFail({ orderId });
    const event = {
      id: `evt_fake_${randomUUID()}`,
      object: 'event',
      type: outcome === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed',
      data: {
        object: {
          id: payment.providerPaymentId,
          object: 'payment_intent',
          amount_received: outcome === 'succeeded' ? payment.amountMinor : 0,
          currency: payment.currency,
          last_payment_error: outcome === 'failed' ? { message: 'Your card was declined (simulated).' } : null,
        },
      },
    } as unknown as Stripe.Event;
    await this.handleStripeEvent(event);
    return this.findForUser(user, orderId);
  }

  // ------------------------------------------------------------------ status changes

  /** Restaurant (or admin) moves an order forward: confirm, preparing, ready, out, delivered. */
  async updateStatus(user: AuthUser, orderId: string, to: OrderStatus) {
    if (to === OrderStatus.CANCELLED) {
      throw new BadRequestException('Use POST /orders/:id/cancel to cancel an order');
    }
    const { actor } = await this.loadWithActor(user, orderId);
    if (actor === 'customer') throw new ForbiddenException('Customers cannot change order status');
    await this.transition(orderId, to, actor, user.id);
    return this.findForUser(user, orderId);
  }

  /**
   * Cancel (customer) or reject (restaurant). If the customer already paid, the money
   * goes back through a Stripe refund; if they hadn't, the PaymentIntent is cancelled so
   * it can't be paid later.
   */
  async cancel(user: AuthUser, orderId: string, reason?: string) {
    const { actor } = await this.loadWithActor(user, orderId);
    await this.transition(orderId, OrderStatus.CANCELLED, actor, user.id, reason ?? `cancelled_by_${actor}`);
    await this.settlePaymentAfterCancel(orderId);
    return this.findForUser(user, orderId);
  }

  /**
   * The single way an order's status changes. Locks the row (SELECT ... FOR UPDATE) so two
   * concurrent requests — say the customer cancelling while the restaurant confirms —
   * are serialised, and the loser gets a clean 409 instead of a corrupted order.
   */
  async transition(
    orderId: string,
    to: OrderStatus,
    actor: Actor,
    actorUserId: string | null,
    reason?: string,
    manager?: EntityManager,
  ): Promise<OrderStatusChanged> {
    const run = async (m: EntityManager) => {
      const order = await m.findOne(Order, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new NotFoundException('Order not found');
      const from = order.status;
      if (!canTransition(from, to, actor)) {
        throw new ConflictException(`Cannot move an order from ${from} to ${to} as ${actor}`);
      }
      order.status = to;
      if (to === OrderStatus.CANCELLED) order.cancelReason = reason ?? null;
      await m.save(order);
      await m.save(m.create(OrderStatusEvent, { orderId, fromStatus: from, toStatus: to, actor, actorUserId }));
      return {
        orderId,
        customerId: order.customerId,
        restaurantId: order.restaurantId,
        from,
        status: to,
        at: new Date().toISOString(),
      };
    };

    if (manager) return run(manager); // caller owns the transaction and emits after commit
    const change = await this.dataSource.transaction(run);
    this.events.emit(ORDER_STATUS_CHANGED, change);
    return change;
  }

  /** Used by the expiry job: cancel an abandoned unpaid order and void its PaymentIntent. */
  async expireUnpaidOrder(orderId: string) {
    await this.transition(orderId, OrderStatus.CANCELLED, 'system', null, 'payment_timeout');
    await this.settlePaymentAfterCancel(orderId);
  }

  private async settlePaymentAfterCancel(orderId: string) {
    const payment = await this.payments.findOneBy({ orderId });
    if (!payment) return;
    try {
      if (payment.status === PaymentStatus.SUCCEEDED) {
        const refund = await this.gateway.refund(payment.providerPaymentId, orderId);
        payment.status = PaymentStatus.REFUNDED;
        payment.refundId = refund.id;
      } else if (payment.status === PaymentStatus.REQUIRES_PAYMENT || payment.status === PaymentStatus.FAILED) {
        await this.gateway.cancelPaymentIntent(payment.providerPaymentId);
        payment.status = PaymentStatus.CANCELED;
      }
      payment.lastError = null;
    } catch (err) {
      // The order stays cancelled; the failed refund is recorded so an admin can retry it.
      payment.lastError = `settle_after_cancel: ${(err as Error).message}`;
      this.logger.error(`Refund/cancel failed for order ${orderId}: ${(err as Error).message}`);
    }
    await this.payments.save(payment);
  }

  // ------------------------------------------------------------------ Stripe webhook

  async handleStripeEvent(event: Stripe.Event): Promise<{ duplicate: boolean }> {
    const changes: OrderStatusChanged[] = [];
    let refundOrderId: string | null = null;

    const duplicate = await this.dataSource.transaction(async (m) => {
      const inserted: unknown[] = await m.query(
        `INSERT INTO processed_webhook_events ("eventId", "type") VALUES ($1, $2)
         ON CONFLICT ("eventId") DO NOTHING RETURNING "eventId"`,
        [event.id, event.type],
      );
      if (inserted.length === 0) return true; // already handled this exact event

      if (event.type !== 'payment_intent.succeeded' && event.type !== 'payment_intent.payment_failed') {
        return false; // recorded, nothing else to do
      }
      const intent = event.data.object as Stripe.PaymentIntent;
      const payment = await m.findOne(Payment, {
        where: { providerPaymentId: intent.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        this.logger.warn(`Webhook for unknown PaymentIntent ${intent.id}`);
        return false;
      }

      if (event.type === 'payment_intent.payment_failed') {
        // The customer can retry with another card on the same PaymentIntent,
        // so the order stays PENDING_PAYMENT.
        payment.status = PaymentStatus.FAILED;
        payment.lastError = intent.last_payment_error?.message ?? 'payment_failed';
        await m.save(payment);
        return false;
      }

      // payment_intent.succeeded: never trust that the amount is right; check it.
      if (intent.amount_received !== payment.amountMinor || intent.currency !== payment.currency) {
        payment.lastError = `amount_mismatch: got ${intent.amount_received} ${intent.currency}`;
        await m.save(payment);
        this.logger.error(`Amount mismatch on order ${payment.orderId}`);
        return false;
      }
      payment.status = PaymentStatus.SUCCEEDED;
      payment.lastError = null;
      await m.save(payment);

      const order = await m.findOneByOrFail(Order, { id: payment.orderId });
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        changes.push(await this.transition(order.id, OrderStatus.PLACED, 'system', null, undefined, m));
      } else if (order.status === OrderStatus.CANCELLED) {
        // Customer cancelled while their payment was still processing: give the money back.
        refundOrderId = order.id;
      }
      return false;
    });

    // Side effects only after the transaction has committed.
    changes.forEach((c) => this.events.emit(ORDER_STATUS_CHANGED, c));
    if (refundOrderId) await this.settlePaymentAfterCancel(refundOrderId);
    return { duplicate };
  }

  // ------------------------------------------------------------------ reads

  /** Works out whether the caller is this order's customer, its restaurant, or an admin. */
  private async loadWithActor(user: AuthUser, orderId: string): Promise<{ order: Order; actor: Actor }> {
    const order = await this.orders.findOne({ where: { id: orderId }, relations: { restaurant: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (user.role === Role.ADMIN) return { order, actor: 'admin' };
    if (order.customerId === user.id) return { order, actor: 'customer' };
    if (
      order.restaurant.ownerId === user.id &&
      order.status !== OrderStatus.PENDING_PAYMENT // unpaid orders aren't the restaurant's business yet
    ) {
      return { order, actor: 'restaurant' };
    }
    throw new NotFoundException('Order not found'); // 404, not 403: don't confirm the order exists
  }

  async findForUser(user: AuthUser, orderId: string) {
    await this.loadWithActor(user, orderId);
    const order = await this.orders.findOneOrFail({
      where: { id: orderId },
      relations: { items: true, history: true },
      order: { history: { id: 'ASC' } },
    });
    const payment = await this.payments.findOneBy({ orderId });
    return { ...order, payment: payment ? { status: payment.status, refunded: !!payment.refundId } : null };
  }

  listForCustomer(user: AuthUser, limit = 20, offset = 0) {
    return this.orders.find({
      where: { customerId: user.id },
      relations: { items: true },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 50),
      skip: offset,
    });
  }

  async listForRestaurant(user: AuthUser, restaurantId: string, status?: OrderStatus, limit = 20, offset = 0) {
    await this.assertManages(user, restaurantId);
    return this.orders.find({
      where: {
        restaurantId,
        status: status && RESTAURANT_VISIBLE_STATUSES.includes(status) ? status : In(RESTAURANT_VISIBLE_STATUSES),
      },
      relations: { items: true },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 50),
      skip: offset,
    });
  }

  listAll(status?: OrderStatus, restaurantId?: string, limit = 50, offset = 0) {
    return this.orders.find({
      where: { ...(status ? { status } : {}), ...(restaurantId ? { restaurantId } : {}) },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
      skip: offset,
    });
  }

  /** Daily sales for a restaurant's dashboard: delivered orders only, food revenue (no delivery fee). */
  async salesReport(user: AuthUser, restaurantId: string, from: Date, to: Date) {
    await this.assertManages(user, restaurantId);
    const rows: { day: string; orders: number; revenueMinor: number }[] = await this.orders.query(
      `SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              count(*)::int AS orders,
              sum("subtotalMinor")::int AS "revenueMinor"
         FROM orders
        WHERE "restaurantId" = $1 AND status = $2 AND "createdAt" >= $3 AND "createdAt" < $4
        GROUP BY 1 ORDER BY 1`,
      [restaurantId, OrderStatus.DELIVERED, from, to],
    );
    return {
      restaurantId,
      currency: this.currency,
      from: from.toISOString(),
      to: to.toISOString(),
      totalOrders: rows.reduce((s, r) => s + r.orders, 0),
      totalRevenueMinor: rows.reduce((s, r) => s + r.revenueMinor, 0),
      days: rows,
    };
  }

  private async assertManages(user: AuthUser, restaurantId: string) {
    const restaurant = await this.restaurants.findOneBy({ id: restaurantId });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (user.role !== Role.ADMIN && restaurant.ownerId !== user.id) {
      throw new ForbiddenException('You do not manage this restaurant');
    }
  }
}
