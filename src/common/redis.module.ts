import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisShutdown implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit();
  }
}

/** One shared ioredis client for caching and carts. Global so any module can inject it. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: 3 }),
    },
    RedisShutdown,
  ],
  exports: [REDIS],
})
export class RedisModule {}
