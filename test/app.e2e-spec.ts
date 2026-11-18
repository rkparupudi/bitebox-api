/**
 * End-to-end tests against real PostgreSQL and Redis. Only Stripe's network calls are faked;
 * webhook signatures are real (signed with Stripe's own test helper and verified by the SDK).
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
import Stripe from 'stripe';
import request from 'supertest';
import { Client } from 'pg';
import Redis from 'ioredis';

const DB = 'postgres://bitebox:bitebox@localhost:5432/bitebox_test';
const WEBHOOK_SECRET = 'whsec_test_secret';
Object.assign(process.env, {
  DATABASE_URL: DB,
  REDIS_URL: 'redis://localhost:6379/1',
  JWT_SECRET: 'test-secret',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  CURRENCY: 'inr',
  DELIVERY_FEE_MINOR: '4000',
  PAYMENTS_PROVIDER: 'stripe',
  RATE_LIMIT_PER_MINUTE: '10000',
  AUTH_RATE_LIMIT_PER_MINUTE: '30',
});

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PaymentGateway } from '../src/payments/payments.module';
import { OrderExpiryJob } from '../src/orders/order-expiry.job';
import { PushMessage, PushService } from '../src/notifications/notifications.module';

/** Captures push messages instead of calling Expo; reports one token as dead. */
class CapturingPush extends PushService {
  sent: PushMessage[] = [];
  protected async post(messages: PushMessage[]) {
    this.sent.push(...messages);
    return messages.map((m) =>
      m.to === 'ExponentPushToken[dead]'
        ? { status: 'error' as const, message: 'not registered', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok' as const },
    );
  }
}

class FakeGateway extends PaymentGateway {
  intents = new Map<string, number>();
  refunds: string[] = [];
  cancelled: string[] = [];
  failNextCreate = false;
  async createPaymentIntent(args: { orderId: string; amountMinor: number }) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('stripe down');
    }
    const id = `pi_test_${args.orderId.slice(0, 8)}`;
    this.intents.set(id, args.amountMinor);
    return { id, clientSecret: `${id}_secret_abc` };
  }
  async getClientSecret(id: string) {
    return `${id}_secret_abc`;
  }
  async refund(paymentIntentId: string) {
    this.refunds.push(paymentIntentId);
    return { id: `re_${paymentIntentId}` };
  }
  async cancelPaymentIntent(id: string) {
    this.cancelled.push(id);
  }
}

const stripe = new Stripe('sk_test_unused', { apiVersion: '2023-10-16' });
let eventSeq = 0;
function stripeEvent(type: string, intent: Partial<Stripe.PaymentIntent>, id = `evt_${++eventSeq}`) {
  return JSON.stringify({ id, object: 'event', type, data: { object: { object: 'payment_intent', ...intent } } });
}
function sign(payload: string, secret = WEBHOOK_SECRET) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe('BiteBox API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let gateway: FakeGateway;
  let baseUrl: string;
  const sockets: Socket[] = [];

  let customer: string, owner: string, otherOwner: string, admin: string;
  let restaurantId: string;
  let otherRestaurantItemId: string;
  const items: Record<string, string> = {};

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function connect(token: string): Promise<{ socket: Socket; events: any[] }> {
    const events: any[] = [];
    const socket = io(`${baseUrl}/orders`, { auth: { token }, transports: ['websocket'] });
    sockets.push(socket);
    socket.on('order.updated', (e) => events.push(e));
    await new Promise<void>((resolve, reject) => {
      socket.on('ready', () => resolve());
      socket.on('connect_error', reject);
    });
    return { socket, events };
  }

  function pay(orderId: string, amount: number) {
    const pi = `pi_test_${orderId.slice(0, 8)}`;
    const body = stripeEvent('payment_intent.succeeded', { id: pi, amount_received: amount, currency: 'inr' });
    return http.post('/payments/webhook').set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body);
  }

  async function checkoutTwoBiryanis() {
    await http.put('/cart/items').set(auth(customer)).send({ menuItemId: items.biryani, quantity: 2 }).expect(200);
    const res = await http.post('/orders').set(auth(customer)).send({ deliveryAddress: '12 ITPL Road, Whitefield' });
    expect(res.status).toBe(201);
    return res.body;
  }

  beforeAll(async () => {
    const pg = new Client({ connectionString: DB });
    await pg.connect();
    await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pg.end();
    const r = new Redis('redis://localhost:6379/1');
    await r.flushdb();
    await r.quit();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PushService)
      .useClass(CapturingPush)
      .overrideProvider(PaymentGateway)
      .useFactory({ inject: [ConfigService], factory: (c: ConfigService) => new FakeGateway(c) })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await configureApp(app);
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;
    http = request(app.getHttpServer()) as any;
    gateway = app.get(PaymentGateway);

    const reg = async (email: string, role?: string) =>
      (await http.post('/auth/register').send({ email, password: 'password123', fullName: email, role }).expect(201)).body.accessToken;
    customer = await reg('cust@example.com');
    owner = await reg('owner@example.com', 'restaurant_owner');
    otherOwner = await reg('owner2@example.com', 'restaurant_owner');

    // Admins can't self-register; insert one directly, as the seed script does.
    const pg2 = new Client({ connectionString: DB });
    await pg2.connect();
    await pg2.query(
      `INSERT INTO users (email, "passwordHash", "fullName", role) VALUES ($1, $2, 'Admin', 'admin')`,
      ['admin@example.com', await bcrypt.hash('password123', 4)],
    );
    await pg2.end();
    admin = (await http.post('/auth/login').send({ email: 'admin@example.com', password: 'password123' }).expect(200)).body.accessToken;

    restaurantId = (await http.post('/restaurants').set(auth(owner)).send({ name: 'Paradise Kitchen', address: 'Whitefield' }).expect(201)).body.id;
    for (const [key, name, price] of [['biryani', 'Chicken Biryani', 32000], ['raita', 'Raita', 6000]] as const) {
      items[key] = (await http.post(`/restaurants/${restaurantId}/menu-items`).set(auth(owner)).send({ name, priceMinor: price, category: 'Mains' }).expect(201)).body.id;
    }
    await http.patch(`/restaurants/${restaurantId}`).set(auth(owner)).send({ isOpen: true }).expect(200);

    const other = (await http.post('/restaurants').set(auth(otherOwner)).send({ name: 'Dosa Corner', address: 'Marathahalli' }).expect(201)).body.id;
    otherRestaurantItemId = (await http.post(`/restaurants/${other}/menu-items`).set(auth(otherOwner)).send({ name: 'Masala Dosa', priceMinor: 9000 }).expect(201)).body.id;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await app?.close();
  });

  describe('auth and roles', () => {
    it('rejects requests without a token', () => http.get('/cart').expect(401));
    it('rejects self-registration as admin', () =>
      http.post('/auth/register').send({ email: 'x@example.com', password: 'password123', fullName: 'X', role: 'admin' }).expect(400));
    it('does not leak password hashes', async () => {
      const res = await http.post('/auth/login').send({ email: 'cust@example.com', password: 'password123' }).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });
    it('gives the same error for wrong password and unknown email', async () => {
      const a = await http.post('/auth/login').send({ email: 'cust@example.com', password: 'wrong-pass' });
      const b = await http.post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong-pass' });
      expect(a.status).toBe(401);
      expect(a.body.message).toEqual(b.body.message);
    });
    it('blocks customers from creating restaurants', () =>
      http.post('/restaurants').set(auth(customer)).send({ name: 'X', address: 'Y' }).expect(403));
    it('blocks an owner from editing another owner\'s menu', () =>
      http.post(`/restaurants/${restaurantId}/menu-items`).set(auth(otherOwner)).send({ name: 'Hack', priceMinor: 1 }).expect(403));
    it('rejects unknown fields in the body', () =>
      http.post(`/restaurants/${restaurantId}/menu-items`).set(auth(owner)).send({ name: 'X', priceMinor: 100, ownerId: 'evil' }).expect(400));
  });

  describe('menu caching', () => {
    it('caches the public menu in Redis and clears it on change', async () => {
      const redis = new Redis('redis://localhost:6379/1');
      await http.get(`/restaurants/${restaurantId}/menu`).expect(200);
      expect(await redis.exists(`menu:${restaurantId}`)).toBe(1);
      await http.patch(`/restaurants/${restaurantId}/menu-items/${items.raita}`).set(auth(owner)).send({ priceMinor: 6500 }).expect(200);
      expect(await redis.exists(`menu:${restaurantId}`)).toBe(0);
      const menu = (await http.get(`/restaurants/${restaurantId}/menu`).expect(200)).body;
      expect(menu.items.find((i: any) => i.id === items.raita).priceMinor).toBe(6500);
      await redis.quit();
    });
  });

  describe('cart', () => {
    it('prices come from the database, not the client', async () => {
      const res = await http.put('/cart/items').set(auth(customer)).send({ menuItemId: items.raita, quantity: 3 }).expect(200);
      expect(res.body.subtotalMinor).toBe(3 * 6500);
      const sneaky = await http.put('/cart/items').set(auth(customer)).send({ menuItemId: items.raita, quantity: 1, priceMinor: 1 });
      expect(sneaky.status).toBe(400);
    });
    it('refuses items from a second restaurant unless replace=true', async () => {
      await http.put('/cart/items').set(auth(customer)).send({ menuItemId: otherRestaurantItemId, quantity: 1 }).expect(409);
      const replaced = await http.put('/cart/items?replace=true').set(auth(customer)).send({ menuItemId: otherRestaurantItemId, quantity: 1 }).expect(200);
      expect(replaced.body.restaurant.name).toBe('Dosa Corner');
      await http.delete('/cart').set(auth(customer)).expect(204);
    });
    it('cannot check out an empty cart', () =>
      http.post('/orders').set(auth(customer)).send({ deliveryAddress: '12 ITPL Road' }).expect(400));
  });

  describe('order lifecycle with payment and real-time updates', () => {
    let orderId: string;
    let total: number;

    it('checkout creates a pending order, a PaymentIntent, and empties the cart', async () => {
      const { order, payment } = await checkoutTwoBiryanis();
      orderId = order.id;
      total = order.totalMinor;
      expect(order.status).toBe('pending_payment');
      expect(order.subtotalMinor).toBe(64000);
      expect(total).toBe(68000);
      expect(order.items[0]).toMatchObject({ name: 'Chicken Biryani', unitPriceMinor: 32000, quantity: 2 });
      expect(payment.clientSecret).toMatch(/_secret_/);
      expect(gateway.intents.get(payment.paymentIntentId)).toBe(68000);
      expect((await http.get('/cart').set(auth(customer))).body.lines).toHaveLength(0);
    });

    it('hides unpaid orders from the restaurant', async () => {
      await http.get(`/orders/${orderId}`).set(auth(owner)).expect(404);
      const list = await http.get(`/restaurants/${restaurantId}/orders`).set(auth(owner)).expect(200);
      expect(list.body).toHaveLength(0);
    });

    it('rejects a webhook with a forged signature', async () => {
      const body = stripeEvent('payment_intent.succeeded', { id: `pi_test_${orderId.slice(0, 8)}`, amount_received: total, currency: 'inr' });
      await http.post('/payments/webhook').set('stripe-signature', sign(body, 'whsec_attacker')).set('content-type', 'application/json').send(body).expect(400);
      expect((await http.get(`/orders/${orderId}`).set(auth(customer))).body.status).toBe('pending_payment');
    });

    it('ignores a payment for the wrong amount', async () => {
      const body = stripeEvent('payment_intent.succeeded', { id: `pi_test_${orderId.slice(0, 8)}`, amount_received: 100, currency: 'inr' });
      await http.post('/payments/webhook').set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body).expect(200);
      expect((await http.get(`/orders/${orderId}`).set(auth(customer))).body.status).toBe('pending_payment');
    });

    it('a signed payment webhook places the order and pushes it to customer and restaurant', async () => {
      const cust = await connect(customer);
      const rest = await connect(owner);
      const other = await connect(otherOwner);

      const body = stripeEvent('payment_intent.succeeded', { id: `pi_test_${orderId.slice(0, 8)}`, amount_received: total, currency: 'inr' }, 'evt_paid_1');
      const first = await http.post('/payments/webhook').set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body).expect(200);
      expect(first.body.duplicate).toBe(false);

      // Stripe retries: the same event again must change nothing.
      const again = await http.post('/payments/webhook').set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body).expect(200);
      expect(again.body.duplicate).toBe(true);

      await new Promise((r) => setTimeout(r, 300));
      expect(cust.events).toEqual([expect.objectContaining({ orderId, status: 'placed' })]);
      expect(rest.events).toEqual([expect.objectContaining({ orderId, status: 'placed' })]);
      expect(other.events).toHaveLength(0);

      const order = (await http.get(`/orders/${orderId}`).set(auth(owner)).expect(200)).body;
      expect(order.status).toBe('placed');
      expect(order.payment.status).toBe('succeeded');
      expect(order.history.map((h: any) => h.toStatus)).toEqual(['pending_payment', 'placed']);
    });

    it('other restaurants cannot see the order', () => http.get(`/orders/${orderId}`).set(auth(otherOwner)).expect(404));

    it('customers cannot move an order forward', () =>
      http.patch(`/orders/${orderId}/status`).set(auth(customer)).send({ status: 'confirmed' }).expect(403));

    it('the restaurant cannot skip steps', () =>
      http.patch(`/orders/${orderId}/status`).set(auth(owner)).send({ status: 'delivered' }).expect(409));

    it('the restaurant runs the order through to delivery', async () => {
      for (const status of ['confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered']) {
        const res = await http.patch(`/orders/${orderId}/status`).set(auth(owner)).send({ status });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(status);
      }
    });

    it('a delivered order cannot be cancelled', () =>
      http.post(`/orders/${orderId}/cancel`).set(auth(customer)).send({}).expect(409));

    it('the sales report counts the delivered order', async () => {
      const res = await http.get(`/restaurants/${restaurantId}/sales`).set(auth(owner)).expect(200);
      expect(res.body.totalOrders).toBe(1);
      expect(res.body.totalRevenueMinor).toBe(64000);
    });
  });

  describe('cancellations and refunds', () => {
    it('cancelling a paid order refunds it', async () => {
      const { order } = await checkoutTwoBiryanis();
      await pay(order.id, order.totalMinor).expect(200);
      const res = await http.post(`/orders/${order.id}/cancel`).set(auth(customer)).send({ reason: 'changed my mind' }).expect(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.payment).toEqual({ status: 'refunded', refunded: true });
      expect(gateway.refunds).toContain(`pi_test_${order.id.slice(0, 8)}`);
    });

    it('cancelling an unpaid order cancels the PaymentIntent', async () => {
      const { order } = await checkoutTwoBiryanis();
      await http.post(`/orders/${order.id}/cancel`).set(auth(customer)).send({}).expect(200);
      expect(gateway.cancelled).toContain(`pi_test_${order.id.slice(0, 8)}`);
    });

    it('a payment that lands after cancellation is refunded automatically', async () => {
      const { order } = await checkoutTwoBiryanis();
      await http.post(`/orders/${order.id}/cancel`).set(auth(customer)).send({}).expect(200);
      await pay(order.id, order.totalMinor).expect(200);
      const after = (await http.get(`/orders/${order.id}`).set(auth(customer))).body;
      expect(after.status).toBe('cancelled');
      expect(after.payment.status).toBe('refunded');
    });

    it('the customer cannot cancel once the restaurant has confirmed', async () => {
      const { order } = await checkoutTwoBiryanis();
      await pay(order.id, order.totalMinor).expect(200);
      await http.patch(`/orders/${order.id}/status`).set(auth(owner)).send({ status: 'confirmed' }).expect(200);
      await http.post(`/orders/${order.id}/cancel`).set(auth(customer)).send({}).expect(409);
      // ...but the restaurant can still reject it, and the customer is refunded.
      const res = await http.post(`/orders/${order.id}/cancel`).set(auth(owner)).send({ reason: 'out of stock' }).expect(200);
      expect(res.body.payment.status).toBe('refunded');
    });

    it('abandoned unpaid orders are expired by the scheduled job', async () => {
      const { order } = await checkoutTwoBiryanis();
      const job = app.get(OrderExpiryJob);
      expect(await job.expireUnpaid(new Date(Date.now() - 60_000))).toBe(0); // too recent
      expect(await job.expireUnpaid(new Date(Date.now() + 1_000))).toBe(1);
      const after = (await http.get(`/orders/${order.id}`).set(auth(customer))).body;
      expect(after.status).toBe('cancelled');
      expect(after.cancelReason).toBe('payment_timeout');
      expect(gateway.cancelled).toContain(`pi_test_${order.id.slice(0, 8)}`);
    });

    it('if Stripe is down at checkout, the order is cancelled and the cart is kept', async () => {
      await http.put('/cart/items').set(auth(customer)).send({ menuItemId: items.biryani, quantity: 1 }).expect(200);
      gateway.failNextCreate = true;
      await http.post('/orders').set(auth(customer)).send({ deliveryAddress: '12 ITPL Road' }).expect(502);
      expect((await http.get('/cart').set(auth(customer))).body.lines).toHaveLength(1);
      await http.delete('/cart').set(auth(customer)).expect(204);
    });
  });

  describe('admin', () => {
    it('non-admins are blocked', () => http.get('/admin/orders').set(auth(owner)).expect(403));

    it('admin sees all orders and can suspend a restaurant', async () => {
      const orders = await http.get('/admin/orders').set(auth(admin)).expect(200);
      expect(orders.body.length).toBeGreaterThanOrEqual(5);
      await http.patch(`/admin/restaurants/${restaurantId}/active`).set(auth(admin)).send({ isActive: false }).expect(200);
      await http.get(`/restaurants/${restaurantId}/menu`).expect(404);
      const list = (await http.get('/restaurants').expect(200)).body;
      expect(list.map((r: any) => r.id)).not.toContain(restaurantId);
    });

    it('a suspended restaurant cannot take orders', async () => {
      await http.put('/cart/items').set(auth(customer)).send({ menuItemId: items.biryani, quantity: 1 }).expect(200);
      await http.post('/orders').set(auth(customer)).send({ deliveryAddress: '12 ITPL Road' }).expect(409);
    });
  });

  describe('push notifications for mobile apps', () => {
    let push: CapturingPush;
    const settle = () => new Promise((r) => setTimeout(r, 300));
    beforeAll(async () => {
      push = app.get(PushService) as CapturingPush;
      // The admin tests above suspended this restaurant; bring it back.
      await http.patch(`/admin/restaurants/${restaurantId}/active`).set(auth(admin)).send({ isActive: true }).expect(200);
      await http.delete('/cart').set(auth(customer)).expect(204);
    });

    it('rejects anything that is not an Expo push token', () =>
      http.post('/devices').set(auth(customer)).send({ token: 'hello', platform: 'android' }).expect(400));

    it('notifies the customer and the restaurant as the order moves', async () => {
      await http.post('/devices').set(auth(customer)).send({ token: 'ExponentPushToken[cust-phone]', platform: 'android' }).expect(204);
      await http.post('/devices').set(auth(customer)).send({ token: 'ExponentPushToken[cust-phone]', platform: 'android' }).expect(204); // idempotent
      await http.post('/devices').set(auth(owner)).send({ token: 'ExponentPushToken[owner-tablet]', platform: 'ios' }).expect(204);
      push.sent = [];

      const { order } = await checkoutTwoBiryanis();
      await settle();
      expect(push.sent).toHaveLength(0); // nothing while unpaid

      await pay(order.id, order.totalMinor).expect(200);
      await settle();
      expect(push.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: 'ExponentPushToken[cust-phone]', title: expect.stringContaining('Order placed'), data: expect.objectContaining({ orderId: order.id, status: 'placed' }) }),
          expect.objectContaining({ to: 'ExponentPushToken[owner-tablet]', title: expect.stringContaining('New order'), body: expect.stringContaining('2 items') }),
        ]),
      );
      expect(push.sent).toHaveLength(2);

      push.sent = [];
      await http.patch(`/orders/${order.id}/status`).set(auth(owner)).send({ status: 'confirmed' }).expect(200);
      await settle();
      expect(push.sent).toEqual([expect.objectContaining({ to: 'ExponentPushToken[cust-phone]', title: expect.stringContaining('Order accepted') })]);
    });

    it('removes devices that Expo reports as unregistered', async () => {
      await http.post('/devices').set(auth(customer)).send({ token: 'ExponentPushToken[dead]', platform: 'ios' }).expect(204);
      push.sent = [];
      const { order } = await checkoutTwoBiryanis();
      await pay(order.id, order.totalMinor).expect(200);
      await settle();
      // First notification is attempted on both of the customer's devices; Expo says one is dead.
      expect(push.sent.map((m) => m.to)).toEqual(expect.arrayContaining(['ExponentPushToken[dead]', 'ExponentPushToken[cust-phone]']));
      push.sent = [];
      await http.post(`/orders/${order.id}/cancel`).set(auth(customer)).send({}).expect(200);
      await settle();
      // ...so the next one only goes to the live device.
      expect(push.sent.map((m) => m.to)).toContain('ExponentPushToken[cust-phone]');
      expect(push.sent.map((m) => m.to)).not.toContain('ExponentPushToken[dead]');
    });

    it('stops notifying a device after sign-out unregisters it', async () => {
      await http.delete('/devices/ExponentPushToken[cust-phone]').set(auth(customer)).expect(204);
      push.sent = [];
      const { order } = await checkoutTwoBiryanis();
      await pay(order.id, order.totalMinor).expect(200);
      await settle();
      expect(push.sent.map((m) => m.to)).toEqual(['ExponentPushToken[owner-tablet]']);
    });
  });

  it('health probes', async () => {
    await http.get('/health/live').expect(200);
    await http.get('/health/ready').expect(200);
  });

  it('the dev payment simulator is off unless PAYMENTS_PROVIDER=fake', () =>
    http.post(`/dev/payments/${restaurantId}/simulate`).set(auth(customer)).send({ outcome: 'succeeded' }).expect(404));

  it('an owner already connected hears orders for a restaurant created after connecting', async () => {
    const rest = await connect(otherOwner);
    const newId = (await http.post('/restaurants').set(auth(otherOwner)).send({ name: 'Late Night Rolls', address: 'Whitefield' }).expect(201)).body.id;
    const item = (await http.post(`/restaurants/${newId}/menu-items`).set(auth(otherOwner)).send({ name: 'Egg Roll', priceMinor: 8000 }).expect(201)).body.id;
    await http.patch(`/restaurants/${newId}`).set(auth(otherOwner)).send({ isOpen: true }).expect(200);
    await http.put('/cart/items?replace=true').set(auth(customer)).send({ menuItemId: item, quantity: 1 }).expect(200);
    const { order } = (await http.post('/orders').set(auth(customer)).send({ deliveryAddress: '12 ITPL Road' }).expect(201)).body;
    await pay(order.id, order.totalMinor).expect(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(rest.events).toEqual([expect.objectContaining({ orderId: order.id, status: 'placed' })]);
  });

  it('rate-limits login attempts', async () => {
    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) {
      const res = await http.post('/auth/login').send({ email: 'cust@example.com', password: 'wrong-pass' });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });

  it('rejects socket connections without a valid token', async () => {
    const socket = io(`${baseUrl}/orders`, { auth: { token: 'garbage' }, transports: ['websocket'] });
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.on('disconnect', () => resolve()));
  });
});
