import { Controller, Get, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { Public } from './auth/auth.module';
import { REDIS } from './common/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get()
  async check() {
    await this.db.query('SELECT 1');
    await this.redis.ping();
    return { status: 'ok' };
  }
}
