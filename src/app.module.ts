import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './common/redis-throttler.storage';
import { REDIS } from './common/redis.module';
import { validateConfig } from './config.validation';
import Redis from 'ioredis';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module';
import { AuthModule, JwtAuthGuard } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { RedisModule } from './common/redis.module';
import { RolesGuard } from './common/roles';
import { dataSourceOptions } from './database/data-source';
import { HealthController } from './health.controller';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { RealtimeModule } from './realtime/orders.gateway';
import { RestaurantsModule } from './restaurants/restaurants.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateConfig }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...dataSourceOptions(config.getOrThrow<string>('DATABASE_URL')),
        migrationsRun: config.get('RUN_MIGRATIONS', 'true') === 'true',
        // Connection pool per instance. Total connections = instances x max, and must stay
        // under the database's max_connections (about 80 on a db.t4g.micro).
        extra: {
          max: Number(config.get('DB_POOL_MAX', 10)),
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS],
      useFactory: (config: ConfigService, redis: Redis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: Number(config.get('RATE_LIMIT_PER_MINUTE', 300)) }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    AuthModule,
    RestaurantsModule,
    CartModule,
    PaymentsModule,
    OrdersModule,
    RealtimeModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate-limit first (cheapest, protects everything), then
    // authenticate (JWT), then authorise (roles).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
