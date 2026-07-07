import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AUTH } from './auth.tokens';
import type { Auth } from './auth';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
}

export type AuthedRequest = FastifyRequest & { user: AuthedUser };

export function toWebHeaders(raw: FastifyRequest['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(','));
  }
  return headers;
}

/**
 * The unified guard (docs/architecture/auth.md): resolves identity from a
 * better-auth session (cookie or bearer session token). The PAT branch
 * (mn_pat_*) joins in MN-028.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const session = await this.auth.api.getSession({ headers: toWebHeaders(request.headers) });
    if (!session) throw new UnauthorizedException('Authentication required');
    (request as AuthedRequest).user = session.user as AuthedUser;
    return true;
  }
}
