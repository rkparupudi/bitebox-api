import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { LessThan, Repository } from 'typeorm';
import { REDIS } from '../common/redis.module';
import { OrderStatus } from './order-status';
import { Order } from './order.entities';
import { OrdersService } from './orders.service';

const LOCK_KEY = 'lock:expire-unpaid-orders';

/**
 * Cancels orders that were never paid, so abandoned checkouts don't sit in
 * pending_payment forever.
 *
 * Every API instance runs this cron. A Redis lock (SET NX PX) makes sure only one of them
 * actually does the work each minute — the standard way to run a scheduled job on a
 * horizontally scaled service without a separate scheduler.
 */
@Injectable()
export class OrderExpiryJob {
  private readonly logger = new Logger(OrderExpiryJob.name);
  private readonly timeoutMinutes: number;

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly ordersService: OrdersService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.timeoutMinutes = Number(config.get('ORDER_PAYMENT_TIMEOUT_MINUTES', 30));
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    const token = randomUUID();
    const acquired = await this.redis.set(LOCK_KEY, token, 'PX', 55_000, 'NX');
    if (!acquired) return; // another instance has it this minute
    try {
      await this.expireUnpaid(new Date(Date.now() - this.timeoutMinutes * 60_000));
    } finally {
      // Release only if we still hold it (compare-and-delete), never someone else's lock.
      await this.redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        1,
        LOCK_KEY,
        token,
      );
    }
  }

  /** Returns how many orders were expired. Public so tests can call it directly. */
  async expireUnpaid(olderThan: Date): Promise<number> {
    const stale = await this.orders.find({
      where: { status: OrderStatus.PENDING_PAYMENT, createdAt: LessThan(olderThan) },
      select: ['id'],
      take: 200,
    });
    let expired = 0;
    for (const { id } of stale) {
      try {
        await this.ordersService.expireUnpaidOrder(id);
        expired++;
      } catch (err) {
        // Most likely the payment webhook won the race and the order is now placed. Fine.
        this.logger.debug(`Skipped expiring ${id}: ${(err as Error).message}`);
      }
    }
    if (expired) this.logger.log(`Expired ${expired} unpaid order(s)`);
    return expired;
  }
}
