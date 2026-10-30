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
import { and, desc, eq } from 'drizzle-orm';
import { oauthConsent } from '../db/auth-schema';
import { parseGrantScopes } from './oauth-grant';
import type { OauthGrant } from './oauth-grant';
import { scopeSatisfies, type ResourceScope, type TokenScope } from '@storyos/schemas';
import { RESOURCE_SCOPABLE_KEY } from '../access/resource-scope';
import type { ChangeSource } from '../db/schema';
import type { RunStamp } from '../common/credential-context';
import { AUTH } from './auth.tokens';
import type { Auth } from './auth';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { user } from '../db/schema';
import { TokensService } from '../tokens/tokens.service';
import { NO_RUN_CREDENTIAL_KEY, RUN_BUTTON_KEY, SCOPE_KEY, SESSION_ONLY_KEY } from './token-scope.guard';
import { MIN_ROLE_KEY } from '../workspaces/workspace-access.guard';
import { resolveAgentIdentity } from '../agents/agent-identity';
import { RUNNER_TOKEN_PREFIX } from '../runners/runner.constants';

/**
 * The scope a token needs for a route. An explicit `@RequiresScope` wins. Otherwise a route that needs the ADMIN ROLE
 * (`@MinRole('admin')`, on the handler or the controller) needs an ADMIN-scoped token for every method, GET included (#1049):
 * the role check only asks whether the token's OWNER is an admin, so before this a "write, no schema changes" token of an
 * admin could invite an attacker as admin, add grants or create an exfiltrating webhook, and a READ token of an admin could
 * read the audit log. Everything else: GET reads, other methods write. Exported so a test can enumerate every route.
 */
export type ReflectTargets = Parameters<Reflector['getAllAndOverride']>[1];
export function requiredTokenScope(reflector: Reflector, targets: ReflectTargets, method: string): TokenScope {
  const explicit = reflector.getAllAndOverride<TokenScope>(SCOPE_KEY, targets);
  if (explicit) return explicit;
  if (reflector.getAllAndOverride<string>(MIN_ROLE_KEY, targets) === 'admin') return 'admin';
  return method === 'GET' ? 'read' : 'write';
}

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
  /** Only set for `via: 'token'` (the workspace the PAT was minted for) and `via: 'oauth'` (the workspace the person approved, #1030). */
  workspaceId?: string;
  /** Only set for `via: 'token'` — the token's power ceiling (MN-134). */
  tokenScope?: TokenScope;
  /** Only set for `via: 'token'` — whether run_button is allowed within write scope. */
  allowRunButton?: boolean;
  /** #543 — only set for a token bound to specific spaces/databases. */
  resourceScope?: { space_ids: string[]; database_ids: string[] };
  /**
   * #357 — what wrote this, for the change log's `source` badge.
   *
   * Derived HERE so every controller reads one answer instead of re-deriving it
   * from `via`. #390 did that derivation inline at each write site, which was
   * correct but could only ever say "session or token" — and Tyron mints an
   * ordinary token, so an agent write was indistinguishable from a script's.
   *
   * A session is a person at a keyboard. A token is a program, and the token
   * ROW says which kind — unset means an ordinary PAT, which is `mcp`.
   */
  source: ChangeSource;
  /**
   * #541 — set only for a token minted for a specific Agent record, and only
   * after `agent-identity.ts`'s live fail-closed check passed THIS request.
   * `agentName` is snapshotted here (not re-read later) so every write this
   * request makes stamps the SAME name, even if the Agent is renamed by a
   * concurrent request mid-flight.
   */
  agentId?: string;
  agentName?: string;
  /** #882 — the api_tokens row acting (only `via: 'token'`); the request's credential context is entered from it. */
  tokenId?: string;
  /** #1132 — set only for a per-run credential (ADR-0021 §4). `RequestMemoInterceptor` enters it into the credential context. */
  run?: RunStamp;
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
  private enforceTokenScope(
    context: ExecutionContext,
    resolved: {
      scope: TokenScope;
      allowRunButton: boolean;
    },
  ): void {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    // #1049 — account-level routes with no :ws (create a workspace, accept an invite, edit the profile) are a person's alone.
    if (this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, [context.getHandler(), context.getClass()])) {
      throw new ForbiddenException('This needs a signed-in session: an API token or an AI connection cannot do it.');
    }
    const required = requiredTokenScope(this.reflector, [context.getHandler(), context.getClass()], request.method);
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

  /** #1030 — the newest grant a person gave this OAuth client, or null. The consent row is the only record of it. */
  private async oauthGrant(userId: string, clientId: string): Promise<OauthGrant | null> {
    const rows = await this.db
      .select({ scopes: oauthConsent.scopes })
      .from(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId), eq(oauthConsent.consentGiven, true)))
      .orderBy(desc(oauthConsent.createdAt))
      .limit(1);
    return parseGrantScopes(rows[0]?.scopes);
  }

  /**
   * #543 — DENY BY DEFAULT for a token bound to specific spaces/databases: only routes marked
   * @ResourceScopable() are reachable. The refusal names the boundary and is the same whether
   * or not the thing asked about exists.
   */
  private enforceResourceBinding(context: ExecutionContext, bound: ResourceScope | null): void {
    if (!bound) return;
    const allowed = this.reflector.getAllAndOverride<boolean>(RESOURCE_SCOPABLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) {
      throw new ForbiddenException(
        'This token is bound to specific spaces or databases; this route is outside that boundary',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const header = request.headers.authorization;
    // #1131 — a Runner's credential is NOT a PAT and works only on /runner/v1/* (RunnerAuthGuard). Say so, rather than letting it
    // fall through the session and OAuth lookups to a bare "Authentication required": the refusal is the same either way, but this
    // one is explicit, pinned by test, and cannot quietly become "accepted" if a later lookup ever learns the prefix.
    if (typeof header === 'string' && header.startsWith(`Bearer ${RUNNER_TOKEN_PREFIX}`)) {
      throw new UnauthorizedException('A Runner token works only on the Runner endpoints, not on this one.');
    }
    if (typeof header === 'string' && header.startsWith('Bearer mn_pat_')) {
      const resolved = await this.tokens.resolve(header.slice('Bearer '.length));
      if (!resolved) throw new UnauthorizedException('Invalid or revoked token');

      // #541 — an agent-scoped token's ACTUAL authority is re-resolved live,
      // every request, from the agent record's CURRENT owner — never trusted
      // from the token's own stored userId, which could be stale the moment
      // ownership changes. No resolvable owner is refused outright: there is
      // no fallback identity an agent's writes could be attributed to
      // instead (fail closed, this ticket's own AC).
      let agentIdentity: { agentId: string; agentName: string } | null = null;
      let effectiveUserId = resolved.userId;
      if (resolved.agentId) {
        const identity = await resolveAgentIdentity(this.db, resolved.workspaceId, resolved.agentId);
        if (!identity) {
          throw new UnauthorizedException('This token\'s agent no longer exists or its owner is no longer an active member');
        }
        agentIdentity = { agentId: resolved.agentId, agentName: identity.agentName };
        effectiveUserId = identity.ownerId;
      }

      const account = await this.db.query.user.findFirst({ where: eq(user.id, effectiveUserId) });
      if (!account) throw new UnauthorizedException('Token owner no longer exists');
      this.enforceTokenScope(context, resolved);
      this.enforceResourceBinding(context, resolved.resourceScope);
      // #1135 — a per-run credential is refused the routes marked @NoRunCredential() (outward effects with no staging path, and
      // anything that would mint a wider credential than the caller's). Only a run credential carries `run`.
      if (resolved.run && this.reflector.getAllAndOverride<boolean>(NO_RUN_CREDENTIAL_KEY, [context.getHandler(), context.getClass()])) {
        throw new ForbiddenException(
          'A Runner run credential cannot do this: it has an effect outside StoryOS (or would widen the credential) and needs a person. Ask the member who owns this agent to do it in StoryOS.',
        );
      }

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
        tokenId: resolved.id,
        workspaceId: resolved.workspaceId,
        tokenScope: resolved.scope,
        allowRunButton: resolved.allowRunButton,
        ...(resolved.resourceScope ? { resourceScope: resolved.resourceScope } : {}),
        // Unset origin = an ordinary PAT = `mcp`, exactly the pre-#357 behaviour.
        source: resolved.origin ?? 'mcp',
        // #541 — undefined (not present) for every non-agent-scoped token, so
        // a write path that doesn't know about this ticket yet still stores
        // nothing for it, rather than an empty string reading as "captured".
        ...(agentIdentity ? { agentId: agentIdentity.agentId, agentName: agentIdentity.agentName } : {}),
        // #1132 — a per-run credential: the run, the Runner and the loop-guard depth, so the request's audit rows can name them.
        ...(resolved.run ? { run: resolved.run } : {}),
      };
      return true;
    }

    const headers = toWebHeaders(request.headers);

    const session = await this.auth.api.getSession({ headers });
    if (session) {
      (request as AuthedRequest).user = session.user as AuthedUser;
      (request as AuthedRequest).auth = { via: 'session', source: 'human' };
      return true;
    }

    // OAuth access token from a hosted-MCP connector (MN-154). getMcpSession exists on
    // auth.api only when MCP_OAUTH enabled the mcp plugin; it validates the Bearer as an
    // OAuth access token and yields the owning user.
    const getMcpSession = (
      this.auth.api as {
        getMcpSession?: (opts: { headers: Headers }) => Promise<{
          userId?: string;
          clientId?: string;
          scopes?: string | string[];
        } | null>;
      }
    ).getMcpSession;
    if (getMcpSession) {
      const mcpToken = await getMcpSession({ headers }).catch(() => null);
      // A valid userId means the Bearer is a live access token minted by our own
      // authorization server (the better-auth `mcp` plugin). We do NOT additionally
      // require a `storyos.mcp` scope: better-auth 1.6.23's plugin silently drops any
      // scope outside its built-in openid/profile/email/offline_access set when it
      // issues a token, so the dedicated scope can be *advertised* (discovery) but is
      // never actually *granted* — requiring it here made every hosted-MCP OAuth token
      // fail with "Authentication required" (#331, proven: issued tokens carry only the
      // four built-in scopes). Accepting on validity alone is safe because this OIDC
      // provider exists ONLY for hosted MCP — regular app login uses better-auth
      // sessions (cookies) and PATs, and nothing else consumes its tokens — so every
      // token it mints is, by construction, an MCP token for the resolved user.
      if (mcpToken?.userId) {
        // #1030 — a token reaches only what its owner APPROVED for this client: all their workspaces or one (#1079: always read and write).
        // better-auth mints the token without either, so the grant is looked up (user + client) on every request. No grant
        // means a flow nobody consented to (or a connection made before consent existed): refused, not defaulted to anything.
        const grant = mcpToken.clientId ? await this.oauthGrant(mcpToken.userId, mcpToken.clientId) : null;
        if (!grant) {
          throw new UnauthorizedException('This AI connection has not been approved. Reconnect the client and approve it when asked.');
        }
        const account = await this.db.query.user.findFirst({ where: eq(user.id, mcpToken.userId) });
        if (account) {
          // A ONE-workspace connection has the ceiling a PAT has (MN-122): 404, not 403, so it cannot probe which other workspaces
          // exist. An ALL-workspaces one is bound by nothing here: membership, role and grants are checked per workspace exactly as
          // for a session (a workspace joined later is reachable, one left is not).
          const params = request.params as { ws?: string } | undefined;
          if (grant.workspaceId && params?.ws && params.ws.toLowerCase() !== grant.workspaceId) {
            throw new NotFoundException('Workspace not found');
          }
          // "My AI, my rules" (ADR-0010, #1079): the AI acts AS the person, with the reach their session has. So an approved OAuth
          // connection carries NO token scope (like a session), and what it may do is decided by the person's ROLE and grants in each
          // workspace: a member's connection is refused on an admin route by their role, an admin's is not. An explicit read/write/admin
          // scope belongs to PATs and agent tokens (#1049), whose scope is the point. Account-level routes stay a person's alone.
          if (this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, [context.getHandler(), context.getClass()])) {
            throw new ForbiddenException('This needs a signed-in session: an API token or an AI connection cannot do it.');
          }
          (request as AuthedRequest).user = {
            id: account.id,
            email: account.email,
            name: account.name,
            image: account.image,
            emailVerified: account.emailVerified,
          };
          // #858 — `mcp`, NOT `human`. The comment above says every token this server mints is an
          // MCP token by construction; the provenance has to say the same. `human` here meant an
          // AI connected through claude.ai skipped every gate meant for agents (ADR-0010's
          // publish rule, action gates, ungating an approval) and was badged as a person. A PAT
          // is `mcp`; this is the same kind of caller. Pinned by test/oauth-source.test.ts.
          (request as AuthedRequest).auth = {
            via: 'oauth',
            source: 'mcp',
            ...(grant.workspaceId ? { workspaceId: grant.workspaceId } : {}),
            allowRunButton: true,
          };
          return true;
        }
      }
    }

    throw new UnauthorizedException('Authentication required');
  }
}
