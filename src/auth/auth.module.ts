import {
  Body,
  ConflictException,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Module,
  Post,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthGuard, PassportModule, PassportStrategy } from '@nestjs/passport';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Role } from '../common/roles';
import { User } from '../users/user.entity';

// ---------- public-route marker + global JWT guard ----------

const IS_PUBLIC = 'isPublic';
/** Mark a route as reachable without a token. Everything else needs one (secure by default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    return isPublic ? true : super.canActivate(context);
  }
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }
  validate(payload: { sub: string; email: string; role: Role }): AuthUser {
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}

// ---------- DTOs ----------

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt only uses the first 72 bytes
  password: string;

  @IsString()
  @MinLength(1)
  fullName: string;

  /** Admins can't self-register; they're created by the seed script. */
  @IsOptional()
  @IsIn([Role.CUSTOMER, Role.RESTAURANT_OWNER])
  role?: Role.CUSTOMER | Role.RESTAURANT_OWNER;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

// ---------- service + controller ----------

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    if (await this.users.exist({ where: { email } })) {
      throw new ConflictException('Email already registered');
    }
    const user = await this.users.save(
      this.users.create({
        email,
        fullName: dto.fullName,
        role: dto.role ?? Role.CUSTOMER,
        passwordHash: await bcrypt.hash(dto.password, 12),
      }),
    );
    return this.issueToken(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findOne({
      where: { email: dto.email.toLowerCase() },
      select: ['id', 'email', 'role', 'fullName', 'passwordHash'],
    });
    // Same error for unknown email and wrong password, so the API doesn't reveal which emails exist.
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issueToken(user);
  }

  private issueToken(user: User) {
    const accessToken = this.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    return {
      accessToken,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
    };
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    PassportModule,
    JwtModule.registerAsync({
      global: true, // the WebSocket gateway verifies tokens too
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '1h') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
