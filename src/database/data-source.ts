import 'reflect-metadata';
import 'dotenv/config'; // the TypeORM CLI and seed script run outside Nest, so load .env here
import { readFileSync } from 'fs';
import { DataSource, DataSourceOptions } from 'typeorm';
import { User } from '../users/user.entity';
import { MenuItem, Restaurant } from '../restaurants/restaurant.entities';
import { Order, OrderItem, OrderStatusEvent } from '../orders/order.entities';
import { Payment, ProcessedWebhookEvent } from '../payments/payments.module';

export const entities = [
  User,
  Restaurant,
  MenuItem,
  Order,
  OrderItem,
  OrderStatusEvent,
  Payment,
  ProcessedWebhookEvent,
];

/**
 * Schema changes go through migrations, never `synchronize: true`, so production schema
 * changes are reviewed SQL files in git rather than whatever the entities say today.
 */
/**
 * TLS to the database. Amazon RDS for PostgreSQL requires it. Set DATABASE_SSL_CA to the
 * RDS certificate bundle (the Docker image ships it at /app/rds-ca.pem) so the server's
 * certificate is actually verified, not just encrypted.
 */
function sslOptions() {
  const ca = process.env.DATABASE_SSL_CA;
  if (ca) return { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true };
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: true };
  return undefined;
}

export function dataSourceOptions(url = process.env.DATABASE_URL): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    ssl: sslOptions(),
    entities,
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
  };
}

// Used by the TypeORM CLI (npm run migration:generate / migration:run).
export default new DataSource(dataSourceOptions());
