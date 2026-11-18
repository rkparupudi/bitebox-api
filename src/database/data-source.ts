import 'reflect-metadata';
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
export function dataSourceOptions(url = process.env.DATABASE_URL): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities,
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
  };
}

// Used by the TypeORM CLI (npm run migration:generate / migration:run).
export default new DataSource(dataSourceOptions());
