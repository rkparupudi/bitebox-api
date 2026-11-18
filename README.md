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
| GET | `/health` | public |

**WebSocket:** `io('http://localhost:3000/orders', { auth: { token } })`, then listen for `order.updated`.

## Run it locally (Windows works fine with Docker Desktop)

```bash
cp .env.example .env              # add your Stripe test keys
docker compose up -d postgres redis
npm install
npm run migration:run
npm run seed                      # admin@ / owner@ / customer@bitebridge.dev, password123
npm run start:dev
```

Or everything in containers: `docker compose up --build`.

### Testing payments with Stripe test mode

```bash
stripe listen --forward-to localhost:3000/payments/webhook   # prints the whsec_... for .env
stripe trigger payment_intent.succeeded                       # or pay with card 4242 4242 4242 4242
```

## Tests

```bash
npm test
```

Unit tests cover the state machine. End-to-end tests (36 in total) run the whole app against real PostgreSQL and Redis: auth and role checks, cache invalidation, cart rules, checkout, forged and replayed webhooks, wrong-amount payments, real-time delivery to the right sockets only, the full lifecycle, refunds, a payment that lands after cancellation, Stripe being down at checkout, and admin suspension. Only Stripe's network calls are faked; webhook signatures are real.

The e2e tests expect Postgres at `localhost:5432` (user/password `bitebridge`, database `bitebridge_test`) and Redis at `localhost:6379`.

## Exercises (next things to build)

- **Delivery fee from distance:** call the Google Maps Distance Matrix API at checkout instead of the flat `DELIVERY_FEE_MINOR`. Restaurants already store latitude and longitude.
- **Expire unpaid orders:** a scheduled job (`@nestjs/schedule`) that cancels `pending_payment` orders older than 30 minutes.
- **Delivery partner role:** a `rider` role that takes `ready_for_pickup` orders and owns `out_for_delivery → delivered`.
- **Refresh tokens and logout** with a token denylist in Redis.
- **Rate limiting** on login and checkout (`@nestjs/throttler` with Redis storage).
- **Join new restaurant rooms live:** an owner who creates a restaurant while connected only hears its orders after reconnecting.
- **Outbox pattern:** write status events to a table in the same transaction and publish from there, so an event is never lost if the process dies between commit and emit.
- **React Native client** using the same REST API and Socket.IO namespace.

## License

MIT
