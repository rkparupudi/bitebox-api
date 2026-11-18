import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { Public } from './auth/auth.module';
import { REDIS } from './common/redis.module';

/**
 * Two probes, because they answer different questions:
 *  - /health/live:  is the process up? If not, restart it.
 *  - /health/ready: can it serve traffic (DB and Redis reachable)? If not, stop sending it
 *    requests, but don't kill it. A DB blip shouldn't restart every container at once.
 */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get(['', 'ready'])
  async ready() {
    try {
      await Promise.all([this.db.query('SELECT 1'), this.redis.ping()]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }
}
