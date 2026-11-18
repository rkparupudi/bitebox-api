import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Stripe from 'stripe';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentStatus {
  REQUIRES_PAYMENT = 'requires_payment',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELED = 'canceled',
  REFUNDED = 'refunded',
}

/** Our record of each Stripe PaymentIntent: the transaction record the platform keeps. */
@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column('uuid')
  orderId: string;

  @Column({ default: 'stripe' })
  provider: string;

  @Index({ unique: true })
  @Column()
  providerPaymentId: string;

  @Column('int')
  amountMinor: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.REQUIRES_PAYMENT })
  status: PaymentStatus;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'text', nullable: true })
  refundId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * Stripe retries webhooks and can deliver the same event more than once. We record each
 * event id in the same transaction as the change it causes, so a repeat is a no-op.
 */
@Entity('processed_webhook_events')
export class ProcessedWebhookEvent {
  @PrimaryColumn()
  eventId: string;

  @Column()
  type: string;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}

/**
 * Thin wrapper over the Stripe SDK. Everything payment-related goes through here, which
 * keeps Stripe out of the business logic and lets tests swap in a fake.
 */
@Injectable()
export class PaymentGateway {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    this.stripe = new Stripe(config.get<string>('STRIPE_SECRET_KEY', 'sk_test_missing'), {
      apiVersion: '2023-10-16',
    });
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET', '');
  }

  async createPaymentIntent(args: {
    orderId: string;
    amountMinor: number;
    currency: string;
    customerEmail: string;
  }): Promise<{ id: string; clientSecret: string }> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: args.amountMinor,
        currency: args.currency,
        automatic_payment_methods: { enabled: true },
        receipt_email: args.customerEmail,
        metadata: { orderId: args.orderId },
      },
      // Same key on a retry returns the same PaymentIntent instead of creating a second one.
      { idempotencyKey: `order:${args.orderId}:pi` },
    );
    return { id: intent.id, clientSecret: intent.client_secret! };
  }

  async getClientSecret(paymentIntentId: string): Promise<string> {
    const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
    return intent.client_secret!;
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(paymentIntentId);
  }

  async refund(paymentIntentId: string, orderId: string): Promise<{ id: string }> {
    const refund = await this.stripe.refunds.create(
      { payment_intent: paymentIntentId, metadata: { orderId } },
      { idempotencyKey: `order:${orderId}:refund` },
    );
    return { id: refund.id };
  }

  /** Verifies the Stripe-Signature header against the raw request body. Throws if forged. */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}

/**
 * Local-development stand-in for Stripe, selected with PAYMENTS_PROVIDER=fake.
 * Lets you run the whole app with no Stripe account: the web app shows a
 * "simulate payment" button that calls POST /dev/payments/:orderId/simulate,
 * which feeds a Stripe-shaped event through exactly the same webhook handler.
 */
@Injectable()
export class FakePaymentGateway extends PaymentGateway {
  async createPaymentIntent(args: { orderId: string }) {
    const id = `pi_fake_${args.orderId.replace(/-/g, '')}`;
    return { id, clientSecret: `${id}_secret_fake` };
  }
  async getClientSecret(paymentIntentId: string) {
    return `${paymentIntentId}_secret_fake`;
  }
  async cancelPaymentIntent() {}
  async refund(paymentIntentId: string) {
    return { id: `re_fake_${paymentIntentId.slice(8, 24)}` };
  }
}

export const isFakePayments = (config: ConfigService) =>
  config.get<string>('PAYMENTS_PROVIDER', 'stripe') === 'fake';

@Module({
  imports: [TypeOrmModule.forFeature([Payment, ProcessedWebhookEvent])],
  providers: [
    {
      provide: PaymentGateway,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        isFakePayments(config) ? new FakePaymentGateway(config) : new PaymentGateway(config),
    },
  ],
  exports: [PaymentGateway, TypeOrmModule],
})
export class PaymentsModule {}
