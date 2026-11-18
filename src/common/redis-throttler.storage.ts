import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';
import { REDIS } from './redis.module';

/**
 * Rate-limit counters in Redis instead of process memory.
 *
 * With in-memory counters, three API instances behind a load balancer give every client
 * three times the limit. Keeping the counter in Redis makes the limit hold across the fleet.
 *
 * Fixed window: the first hit creates the counter with a TTL; going over the limit sets a
 * separate block key for `blockDuration`. Done in one Lua script so it's atomic.
 */
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) and redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
end
local blockTtl = redis.call('PTTL', KEYS[2])
return { hits, ttl, blockTtl }
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    // The {braces} are a Redis Cluster hash tag: both keys land in the same slot, so this
    // two-key script also works on clustered Redis/Valkey (e.g. ElastiCache Serverless).
    const hitKey = `throttle:{${throttlerName}:${key}}`;
    const blockKey = `${hitKey}:blocked`;
    const [hits, ttlMs, blockTtlMs] = (await this.redis.eval(
      SCRIPT,
      2,
      hitKey,
      blockKey,
      ttl,
      limit,
      Math.max(blockDuration, 1),
    )) as [number, number, number];
    const isBlocked = blockTtlMs > 0;
    return {
      totalHits: hits,
      timeToExpire: Math.max(Math.ceil(ttlMs / 1000), 0),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockTtlMs / 1000) : 0,
    };
  }
}
