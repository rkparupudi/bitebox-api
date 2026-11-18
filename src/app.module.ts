import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
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
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...dataSourceOptions(config.getOrThrow<string>('DATABASE_URL')),
        migrationsRun: config.get('RUN_MIGRATIONS', 'true') === 'true',
      }),
    }),
    EventEmitterModule.forRoot(),
    RedisModule,
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
    // Order matters: authenticate first (JWT), then authorise (roles).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
