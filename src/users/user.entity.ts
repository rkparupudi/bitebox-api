import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Role } from '../common/roles';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  /** bcrypt hash. Never selected by default so it can't leak into API responses. */
  @Column({ select: false })
  passwordHash: string;

  @Column()
  fullName: string;

  @Column({ type: 'enum', enum: Role, default: Role.CUSTOMER })
  role: Role;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
