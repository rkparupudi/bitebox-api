import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export enum Role {
  CUSTOMER = 'customer',
  RESTAURANT_OWNER = 'restaurant_owner',
  ADMIN = 'admin',
}

/** What the JWT strategy puts on request.user after verifying a token. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

const ROLES_KEY = 'roles';

/** Restrict a route (or a whole controller) to one or more roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Inject the authenticated user into a handler parameter. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

/**
 * Runs after JwtAuthGuard. Routes without @Roles are open to any signed-in user;
 * routes with @Roles need the user's role to be in the list.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
    return !!user && required.includes(user.role);
  }
}
