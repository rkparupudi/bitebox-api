import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { MenuItem, Restaurant } from '../restaurants/restaurant.entities';
import { User } from '../users/user.entity';
import { OrderStatus } from './order-status';

@Entity('orders')
@Index(['restaurantId', 'status', 'createdAt'])
@Index(['customerId', 'createdAt'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  customer: User;

  @Column('uuid')
  restaurantId: string;

  @ManyToOne(() => Restaurant, { onDelete: 'RESTRICT' })
  restaurant: Restaurant;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING_PAYMENT })
  status: OrderStatus;

  @Column('int')
  subtotalMinor: number;

  @Column('int')
  deliveryFeeMinor: number;

  @Column('int')
  totalMinor: number;

  @Column({ length: 3 })
  currency: string;

  @Column()
  deliveryAddress: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'text', nullable: true })
  cancelReason: string | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ['insert'] })
  items: OrderItem[];

  @OneToMany(() => OrderStatusEvent, (e) => e.order)
  history: OrderStatusEvent[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @VersionColumn()
  version: number;
}

/**
 * A snapshot of what was bought. Name and price are copied from the menu at checkout,
 * so editing or deleting a menu item later never changes a past order or its receipt.
 */
@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  orderId: string;

  @ManyToOne(() => Order, (o) => o.items, { onDelete: 'CASCADE' })
  order: Order;

  @Column('uuid', { nullable: true })
  menuItemId: string | null;

  @ManyToOne(() => MenuItem, { onDelete: 'SET NULL', nullable: true })
  menuItem: MenuItem | null;

  @Column()
  name: string;

  @Column('int')
  unitPriceMinor: number;

  @Column('int')
  quantity: number;
}

/** Append-only audit trail of every status change: who, from what, to what, when. */
@Entity('order_status_events')
export class OrderStatusEvent {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Index()
  @Column('uuid')
  orderId: string;

  @ManyToOne(() => Order, (o) => o.history, { onDelete: 'CASCADE' })
  order: Order;

  @Column({ type: 'enum', enum: OrderStatus, nullable: true })
  fromStatus: OrderStatus | null;

  @Column({ type: 'enum', enum: OrderStatus })
  toStatus: OrderStatus;

  /** 'customer' | 'restaurant' | 'admin' | 'system' */
  @Column()
  actor: string;

  @Column('uuid', { nullable: true })
  actorUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}
