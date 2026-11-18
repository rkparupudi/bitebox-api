import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('restaurants')
export class Restaurant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  owner: User;

  @Column()
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column()
  address: string;

  /** Stored now so a Google Maps distance/ETA lookup can be added without a migration. */
  @Column({ type: 'double precision', nullable: true })
  latitude: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude: number | null;

  /** Owner-controlled: is the kitchen taking orders right now? */
  @Column({ default: false })
  isOpen: boolean;

  /** Admin-controlled: a suspended restaurant is hidden and can't take orders. */
  @Column({ default: true })
  isActive: boolean;

  @OneToMany(() => MenuItem, (item) => item.restaurant)
  menuItems: MenuItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('menu_items')
export class MenuItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  restaurantId: string;

  @ManyToOne(() => Restaurant, (r) => r.menuItems, { onDelete: 'CASCADE' })
  restaurant: Restaurant;

  @Column()
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ default: 'Mains' })
  category: string;

  /**
   * Price in the currency's smallest unit (paise, cents). Money is never a float:
   * 0.1 + 0.2 !== 0.3, and Stripe takes integer minor units anyway.
   */
  @Column('int')
  priceMinor: number;

  @Column({ default: true })
  isAvailable: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
