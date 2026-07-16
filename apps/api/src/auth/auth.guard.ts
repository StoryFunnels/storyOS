import {
  ForbiddenException,
  Injectable,
  Inject,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { scopeSatisfies, type TokenScope } from '@storyos/schemas';
import { AUTH } from './auth.tokens';
import type { Auth } from './auth';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { user } from '../db/schema';
import { TokensService } from '../tokens/tokens.service';
import { RUN_BUTTON_KEY, SCOPE_KEY } from './token-scope.guard';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
}

/**
 * How this request authenticated. `via: 'token'` carries the PAT's workspace, so
 * downstream code can tell a scoped credential from a full session (MN-122).
 */
export interface AuthContext {
  via: 'session' | 'token' | 'oauth';
  /** Only set for `via: 'token'` — the workspace the PAT was minted for. */
  workspaceId?: string;
  /** Only set for `via: 'token'` — the token's power ceiling (MN-134). */
  tokenScope?: TokenScope;
  /** Only set for `via: 'token'` — whether run_button is allowed within write scope. */
  allowRunButton?: boolean;
}

export type AuthedRequest = FastifyRequest & { user: AuthedUser; auth: AuthContext };

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
    private readonly reflector: Reflector,
  ) {}

  /**
   * MN-134: a scoped PAT is refused any endpoint above its ceiling — here, in the
   * one guard that runs on every authenticated route, so it holds even if a
   * controller forgets a guard or an agent hand-crafts a call to an unadvertised
   * tool. Required scope: @RequiresScope override, else GET → read / else write.
   */
  private enforceTokenScope(context: ExecutionContext, resolved: {
    scope: TokenScope;
    allowRunButton: boolean;
  }): void {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const explicit = this.reflector.getAllAndOverride<TokenScope>(SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const required: TokenScope = explicit ?? (request.method === 'GET' ? 'read' : 'write');
    if (!scopeSatisfies(resolved.scope, required)) {
      throw new ForbiddenException(
        `This token is ${resolved.scope}-scoped; ${required} access is required here.`,
      );
    }
    const isRunButton = this.reflector.getAllAndOverride<boolean>(RUN_BUTTON_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isRunButton && !resolved.allowRunButton) {
      throw new ForbiddenException('This token is not allowed to run buttons.');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer mn_pat_')) {
      const resolved = await this.tokens.resolve(header.slice('Bearer '.length));
      if (!resolved) throw new UnauthorizedException('Invalid or revoked token');
      const account = await this.db.query.user.findFirst({ where: eq(user.id, resolved.userId) });
      if (!account) throw new UnauthorizedException('Token owner no longer exists');
      this.enforceTokenScope(context, resolved);

      /**
       * MN-122: a PAT is minted FOR a workspace, so it must only work there.
       * The check lives here, not in WorkspaceAccessGuard, because this guard runs
       * on every authenticated route — a controller that forgets the workspace
       * guard still cannot escape its token's scope. `:ws` is always a raw uuid
       * (WorkspaceAccessGuard 404s anything else), so comparing it is safe.
       *
       * 404, not 403: the no-leak convention — a token for another workspace must
       * not be able to probe which workspaces exist.
       */
      const params = request.params as { ws?: string } | undefined;
      if (params?.ws && params.ws !== resolved.workspaceId) {
        throw new NotFoundException('Workspace not found');
      }

      (request as AuthedRequest).user = {
        id: account.id,
        email: account.email,
        name: account.name,
        image: account.image,
        emailVerified: account.emailVerified,
      };
      (request as AuthedRequest).auth = {
        via: 'token',
        workspaceId: resolved.workspaceId,
        tokenScope: resolved.scope,
        allowRunButton: resolved.allowRunButton,
      };
      return true;
    }

    const headers = toWebHeaders(request.headers);

    const session = await this.auth.api.getSession({ headers });
    if (session) {
      (request as AuthedRequest).user = session.user as AuthedUser;
      (request as AuthedRequest).auth = { via: 'session' };
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
          (request as AuthedRequest).auth = { via: 'oauth' };
          return true;
        }
      }
    }

    throw new UnauthorizedException('Authentication required');
  }
}
