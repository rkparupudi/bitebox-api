/**
 * Runs the app the way you will locally: PAYMENTS_PROVIDER=fake, no Stripe account.
 * Checks the simulated payment goes through the same webhook path as real Stripe.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import Redis from 'ioredis';

const DB = 'postgres://bitebridge:bitebridge@localhost:5432/bitebridge_test';
Object.assign(process.env, {
  DATABASE_URL: DB,
  REDIS_URL: 'redis://localhost:6379/2',
  JWT_SECRET: 'test-secret',
  PAYMENTS_PROVIDER: 'fake',
  RATE_LIMIT_PER_MINUTE: '10000',
  AUTH_RATE_LIMIT_PER_MINUTE: '1000',
});

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('local fake-payment mode (e2e)', () => {
  let app: INestApplication;
  let http: any;

  beforeAll(async () => {
    const pg = new Client({ connectionString: DB });
    await pg.connect();
    await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pg.end();
    const r = new Redis('redis://localhost:6379/2');
    await r.flushdb();
    await r.quit();
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ rawBody: true });
    await configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
  });
  afterAll(() => app?.close());

  it('checkout and simulated payment place the order; a simulated decline leaves it payable', async () => {
    const reg = async (email: string, role?: string) =>
      (await http.post('/auth/register').send({ email, password: 'password123', fullName: email, role }).expect(201)).body.accessToken;
    const owner = await reg('o@example.com', 'restaurant_owner');
    const customer = await reg('c@example.com');
    const a = (t: string) => ({ Authorization: `Bearer ${t}` });

    expect((await http.get('/config').expect(200)).body.paymentsProvider).toBe('fake');

    const rid = (await http.post('/restaurants').set(a(owner)).send({ name: 'R', address: 'A' }).expect(201)).body.id;
    const item = (await http.post(`/restaurants/${rid}/menu-items`).set(a(owner)).send({ name: 'Idli', priceMinor: 5000 }).expect(201)).body.id;
    await http.patch(`/restaurants/${rid}`).set(a(owner)).send({ isOpen: true }).expect(200);
    await http.put('/cart/items').set(a(customer)).send({ menuItemId: item, quantity: 2 }).expect(200);
    const { order, payment } = (await http.post('/orders').set(a(customer)).send({ deliveryAddress: 'Somewhere 1' }).expect(201)).body;
    expect(payment.clientSecret).toContain('_secret_fake');

    const declined = await http.post(`/dev/payments/${order.id}/simulate`).set(a(customer)).send({ outcome: 'failed' }).expect(200);
    expect(declined.body.status).toBe('pending_payment');
    expect(declined.body.payment.status).toBe('failed');

    const paid = await http.post(`/dev/payments/${order.id}/simulate`).set(a(customer)).send({ outcome: 'succeeded' }).expect(200);
    expect(paid.body.status).toBe('placed');
    expect(paid.body.payment.status).toBe('succeeded');
  });
});
