import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { AUTH } from './auth.tokens';
import type { Auth } from './auth';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { user } from '../db/schema';
import { TokensService } from '../tokens/tokens.service';

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
 * The unified guard (docs/architecture/auth.md): one resolution path for
 * better-auth sessions (cookie or bearer session token) AND personal access
 * tokens (`Bearer mn_pat_...`) — downstream code never cares which.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly tokens: TokensService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer mn_pat_')) {
      const resolved = await this.tokens.resolve(header.slice('Bearer '.length));
      if (!resolved) throw new UnauthorizedException('Invalid or revoked token');
      const account = await this.db.query.user.findFirst({ where: eq(user.id, resolved.userId) });
      if (!account) throw new UnauthorizedException('Token owner no longer exists');
      (request as AuthedRequest).user = {
        id: account.id,
        email: account.email,
        name: account.name,
        image: account.image,
        emailVerified: account.emailVerified,
      };
      return true;
    }

    const headers = toWebHeaders(request.headers);

    const session = await this.auth.api.getSession({ headers });
    if (session) {
      (request as AuthedRequest).user = session.user as AuthedUser;
      return true;
    }

    // OAuth access token from a hosted-MCP connector (MN-154). getMcpSession exists on
    // auth.api only when MCP_OAUTH enabled the mcp plugin; it validates the Bearer as an
    // OAuth access token and yields the owning user.
    const getMcpSession = (
      this.auth.api as {
        getMcpSession?: (opts: { headers: Headers }) => Promise<{ userId?: string } | null>;
      }
    ).getMcpSession;
    if (getMcpSession) {
      const mcpToken = await getMcpSession({ headers }).catch(() => null);
      if (mcpToken?.userId) {
        const account = await this.db.query.user.findFirst({ where: eq(user.id, mcpToken.userId) });
        if (account) {
          (request as AuthedRequest).user = {
            id: account.id,
            email: account.email,
            name: account.name,
            image: account.image,
            emailVerified: account.emailVerified,
          };
          return true;
        }
      }
    }

    throw new UnauthorizedException('Authentication required');
  }
}
