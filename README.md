# BiteBridge API

Backend for a food ordering and delivery platform. Customers browse restaurants, build a cart, pay with Stripe and track their order live. Restaurants manage menus, work through incoming orders and see their sales. Admins oversee the platform.

**Stack:** NestJS 10 · TypeScript · PostgreSQL 16 (TypeORM, migrations) · Redis (cache, carts, Socket.IO adapter) · Stripe (PaymentIntents + webhooks) · Socket.IO · Docker · Jest + Supertest

I built this as a learning project from a real Upwork brief, to get hands-on with NestJS, TypeScript, PostgreSQL, Stripe and WebSockets on a realistic domain.

## Architecture

```
Client (web / React Native)
   │  REST (JWT)                    │  Socket.IO /orders (JWT)
   ▼                                ▼
┌────────────────────────── NestJS API ───────────────────────────┐
│ AuthModule      JWT + bcrypt, global JwtAuthGuard + RolesGuard  │
│ Restaurants     restaurants, menus  ──cache-aside──▶ Redis       │
│ Cart            cart:<userId> in Redis (ids + qty only)         │
│ Orders          checkout, state machine, sales report           │
│ Payments        Stripe gateway, webhook (signed, idempotent)    │
│ Realtime        OrdersGateway ◀── order.status_changed event    │
│ Admin           all orders, suspend restaurants                  │
└───────────────┬───────────────────────────┬─────────────────────┘
                ▼                           ▼
           PostgreSQL                  Redis (also pub/sub for
     (source of truth, migrations)     Socket.IO across instances)
```

### The order flow

1. `POST /orders` turns the cart into an order in `pending_payment` and creates a Stripe PaymentIntent. The response carries the `clientSecret` the app uses to collect the card.
2. Stripe calls `POST /payments/webhook` with `payment_intent.succeeded`. The signature is verified, the amount is checked, and the order moves to `placed`.
3. The restaurant moves it through `confirmed → preparing → ready_for_pickup → out_for_delivery → delivered`.
4. Every change is pushed over Socket.IO to the customer, the restaurant and admins.

Cancellation: the customer can cancel until the restaurant confirms; the restaurant can reject until it starts preparing. Paid orders are refunded through Stripe automatically.

## Design decisions worth studying

| Decision | Where | Why |
|---|---|---|
| Money as integer minor units (paise) | `priceMinor`, `totalMinor` | Floats can't represent money exactly; Stripe uses minor units |
| Explicit order state machine | `orders/order-status.ts` | All lifecycle rules in one table, unit-tested on their own |
| Row lock on every status change | `OrdersService.transition` | Customer cancelling while the restaurant confirms can't corrupt the order; the loser gets a 409 |
| Only the webhook marks an order paid | `order-status.ts` (`'system'` only) | The client can't claim it paid; Stripe has to say so |
| Webhook signature verified on the raw body | `main.ts` `rawBody: true`, `PaymentGateway.constructEvent` | Anyone can POST to a public URL; the signature proves it's Stripe |
| Webhook idempotency table, same transaction | `processed_webhook_events` | Stripe retries; a repeated event must not double-process |
| Amount re-checked on payment | `handleStripeEvent` | Never trust that what was paid matches what was ordered |
| Stripe idempotency keys | `order:<id>:pi`, `order:<id>:refund` | A retried request can't create two charges or two refunds |
| No DB transaction across the Stripe call | `checkout` | Holding a transaction open over a network call ties up the database |
| Order items snapshot name and price | `order_items` | Editing the menu later never changes a past order |
| Cart stores ids and quantities only | `cart.module.ts` | Prices always come from the database; the client can't set them |
| Menu cache-aside with invalidation on write | `RestaurantsService.getMenu` | Hot read path served from Redis, never stale after an edit |
| Secure by default auth | global `JwtAuthGuard`, opt out with `@Public()` | Forgetting a decorator fails closed, not open |
| 404 (not 403) for orders you can't see | `loadWithActor` | Doesn't reveal that an order id exists |
| Unknown request fields rejected | `ValidationPipe({ forbidNonWhitelisted })` | Blocks mass-assignment like sending `ownerId` or `priceMinor` |
| Socket rooms assigned by the server | `OrdersGateway.handleConnection` | Clients can't subscribe to someone else's orders |
| Socket.IO Redis adapter | `app.setup.ts` | Real-time keeps working when you run more than one API instance |
| Migrations, not `synchronize` | `src/database/migrations` | Schema changes are reviewed SQL in git |
| Migrations run once per deploy | `src/database/migrate.ts`, deploy workflow | Several containers starting together never race to migrate |
| Rate limits stored in Redis | `common/redis-throttler.storage.ts` | Limits hold across all instances, not per instance |
| Scheduled job with a Redis lock | `orders/order-expiry.job.ts` | Every instance runs the cron; only one does the work |
| Liveness vs readiness probes | `health.controller.ts` | A DB blip stops traffic to a task without killing it |
| Fail-fast config validation | `config.validation.ts` | Refuses to start in production with fake payments, a weak JWT secret or a missing CORS allow-list |
| Verified TLS to the database | `DATABASE_SSL_CA` | Encrypted *and* authenticated connection to RDS |

## API

Full interactive docs at `http://localhost:3000/docs` (Swagger).

| Method | Path | Who |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | public |
| GET | `/auth/me` | any signed-in user |
| GET | `/restaurants?q=`, `/restaurants/:id/menu` | public |
| GET | `/restaurants/mine` | owner |
| POST/PATCH | `/restaurants`, `/restaurants/:id` | owner |
| GET/POST/PATCH/DELETE | `/restaurants/:id/menu-items[/:itemId]` | owner |
| GET/PUT/DELETE | `/cart`, `/cart/items?replace=true` | customer |
| POST | `/orders` (checkout) | customer |
| GET | `/orders`, `/orders/:id`, `/orders/:id/payment` | customer (own); `/orders/:id` also restaurant, admin |
| PATCH | `/orders/:id/status` | owner, admin |
| POST | `/orders/:id/cancel` | customer, owner, admin (rules apply) |
| GET | `/restaurants/:id/orders?status=`, `/restaurants/:id/sales?from=&to=` | owner, admin |
| POST | `/payments/webhook` | Stripe (signature-verified) |
| GET/PATCH | `/admin/orders`, `/admin/restaurants`, `/admin/restaurants/:id/active` | admin |
| GET | `/health/live`, `/health/ready` | public |
| GET | `/config` | public (what the web app needs: payment mode, Stripe publishable key) |
| POST | `/dev/payments/:orderId/simulate` | customer, only when `PAYMENTS_PROVIDER=fake` |

**WebSocket:** `io('http://localhost:3000/orders', { auth: { token } })`, then listen for `order.updated`.

## Run it locally (Windows, macOS or Linux)

You need **Node.js 22** and **Docker Desktop**.

```bash
# 1. Database and Redis
docker compose up -d postgres redis

# 2. API (first terminal)
cp .env.example .env          # Windows PowerShell: copy .env.example .env
npm install
npm run seed                  # creates tables and demo data
npm run start:dev             # http://localhost:3000, docs at /docs

# 3. Web app (second terminal), from the bitebridge-web folder
npm install
npm run dev                   # http://localhost:5173
```

Open http://localhost:5173 and use the one-click demo sign-ins (customer, owner, admin; password `password123`). Put the customer in one browser window and the owner in another (or an incognito window), place an order, and watch it show up on the restaurant's board instantly.

`.env.example` sets `PAYMENTS_PROVIDER=fake`, so **no Stripe account is needed**: the checkout shows Pay and Simulate-declined buttons. These send a Stripe-shaped event through the same webhook handler production uses. To use real Stripe test mode, set `PAYMENTS_PROVIDER=stripe` and your test keys, then run:

```bash
stripe listen --forward-to localhost:3000/payments/webhook   # prints the whsec_... for .env
```

and pay with card `4242 4242 4242 4242`.

## Deploying

See **[DEPLOYMENT.md](DEPLOYMENT.md)**: a ~$12/month single-server option and a ~$80–90/month production setup on ECS Fargate, RDS and ElastiCache, with GitHub Actions pipelines for both repos.

## Tests

```bash
npm test
```

Unit tests cover the state machine. End-to-end tests (42 in total, across two suites) run the whole app against real PostgreSQL and Redis: auth and role checks, cache invalidation, cart rules, checkout, forged and replayed webhooks, wrong-amount payments, real-time delivery to the right sockets only, the full lifecycle, refunds, a payment that lands after cancellation, Stripe being down at checkout, admin suspension, the unpaid-order expiry job, rate limiting, health probes, live room joins, and the local fake-payment mode. Only Stripe's network calls are faked; webhook signatures are real.

The e2e tests expect Postgres at `localhost:5432` (user/password `bitebridge`, database `bitebridge_test`) and Redis at `localhost:6379`.

## Exercises (next things to build)

- **Delivery fee from distance:** call the Google Maps Distance Matrix API at checkout instead of the flat `DELIVERY_FEE_MINOR`. Restaurants already store latitude and longitude.
- **Delivery partner role:** a `rider` role that takes `ready_for_pickup` orders and owns `out_for_delivery → delivered`.
- **Refresh tokens and logout** with a token denylist in Redis.
- **Outbox pattern:** write status events to a table in the same transaction and publish from there, so an event is never lost if the process dies between commit and emit.
- **React Native client** using the same REST API and Socket.IO namespace.
- **Infrastructure as code:** turn the console steps in DEPLOYMENT.md into Terraform or AWS CDK.

## License

MIT
