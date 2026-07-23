import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { ProviderDescriptorSummary } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { automationJobs, connections } from '../db/schema';
import { env } from '../config/env';
import { open, seal } from '../common/secretbox';
import { NotificationsService } from '../notifications/notifications.service';
import { PROVIDER_REGISTRY } from './providers';
import type { ConnectionFetcher, ProviderDescriptor } from './providers';

type ConnectionRow = typeof connections.$inferSelect;

/** The CSRF-signed state carried through the OAuth round-trip (mirrors
 * GithubAppService.signState/verifyState in integrations/github-app.service.ts). */
interface OAuthState {
  ws: string;
  provider: string;
  /** The admin who started the connect — becomes the connection's createdBy,
   * and later the refresh-failure notification recipient. */
  uid: string;
  n: string;
  t: number;
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
/** Refresh an OAuth2 connection's token once it's within this long of expiry. */
const REFRESH_WINDOW_MS = 15 * 60 * 1000;
const REFRESH_TICK_MS = 5 * 60 * 1000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

/**
 * MN-252 — the workspace credential registry. Owns the `connections` table,
 * the provider registry, the OAuth2 authorize/callback plumbing, and the
 * background token-refresh loop. Exported so later tickets (send_email,
 * post_social, the Apify source, http_request…) can inject it exactly like
 * automations.module.ts imports IntegrationsModule today.
 */
@Injectable()
export class ConnectionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectionsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Swappable in tests — forwarded into every provider healthCheck/OAuth call. */
  fetcher: ConnectionFetcher = (url, init) =>
    fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body }) as unknown as ReturnType<ConnectionFetcher>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.refreshDueTokens(), REFRESH_TICK_MS);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ── provider catalog ─────────────────────────────────────────────────────

  listProviders(): { data: ProviderDescriptorSummary[] } {
    const data = [...PROVIDER_REGISTRY.values()].map((p) => ({
      id: p.id,
      label: p.label,
      auth_kind: p.authKind,
      ...(p.oauth
        ? {
            oauth: {
              scopes: p.oauth.scopes,
              configured: Boolean(process.env[p.oauth.clientIdEnv]?.trim() && process.env[p.oauth.clientSecretEnv]?.trim()),
            },
          }
        : {}),
    }));
    return { data };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async list(workspaceId: string) {
    const rows = await this.db.query.connections.findMany({
      where: eq(connections.workspaceId, workspaceId),
      orderBy: [desc(connections.createdAt)],
    });
    const errorCounts = rows.length
      ? await this.recentErrorCounts(rows.map((r) => r.id))
      : new Map<string, number>();
    return { data: rows.map((r) => this.present(r, errorCounts.get(r.id) ?? 0)) };
  }

  /**
   * MN-264 — last-24h failed-job count per connection, for the Connections
   * health strip. Reads automation_jobs (MN-253's durable queue) rather than
   * a new counter: `updatedAt` is bumped by `$onUpdate` on every status write,
   * so a job's `status = 'failed'` row's `updatedAt` IS its failure time.
   */
  private async recentErrorCounts(connectionIds: string[]): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select({ connectionId: automationJobs.connectionId, count: sql<number>`count(*)::int` })
      .from(automationJobs)
      .where(
        and(
          inArray(automationJobs.connectionId, connectionIds),
          eq(automationJobs.status, 'failed'),
          gte(automationJobs.updatedAt, since),
        ),
      )
      .groupBy(automationJobs.connectionId);
    return new Map(rows.filter((r) => r.connectionId).map((r) => [r.connectionId as string, r.count]));
  }

  /** Client-safe view — NEVER includes authSealed (MN-252 AC). */
  private present(row: ConnectionRow, errorCount24h = 0) {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      status: row.status,
      scopes: (row.scopes ?? []) as string[],
      last_ok_at: row.lastOkAt ? row.lastOkAt.toISOString() : null,
      created_at: row.createdAt.toISOString(),
      // MN-264: circuit-breaker + recent-error visibility for the Connections
      // health strip. breakerOpenUntil was pre-provisioned by MN-253 but never
      // surfaced to a client until now.
      error_count_24h: errorCount24h,
      breaker_open_until: row.breakerOpenUntil ? row.breakerOpenUntil.toISOString() : null,
    };
  }

  async create(
    workspaceId: string,
    input: { provider: string; name: string; auth: Record<string, unknown> },
    userId: string,
  ) {
    const descriptor = this.requireProvider(input.provider);
    if (descriptor.authKind === 'oauth2') {
      throw new BadRequestException(
        `${descriptor.label} connects via OAuth — use the connect button, not a direct create.`,
      );
    }
    // Runs BEFORE insert (MN-252 AC): a connection that never worked is never stored.
    await descriptor.healthCheck(input.auth, this.fetcher);
    const sealed = seal(JSON.stringify(input.auth));
    const [row] = await this.db
      .insert(connections)
      .values({
        workspaceId,
        provider: descriptor.id,
        name: input.name,
        authSealed: sealed,
        scopes: [],
        status: 'active',
        lastOkAt: new Date(),
        createdBy: userId,
      })
      .returning();
    return this.present(row!);
  }

  /**
   * MN-264 — manual circuit-breaker reset: clears `breakerOpenUntil` (and the
   * error streak that opened it) so JobRunnerService's claim loop stops
   * short-circuiting this connection's jobs before the 30-minute cool-down
   * elapses on its own. Does not touch history — queued/failed jobs are
   * untouched; the next claim just isn't gated on the breaker anymore.
   */
  async resume(workspaceId: string, id: string) {
    await this.requireRow(workspaceId, id);
    const [row] = await this.db
      .update(connections)
      .set({ breakerOpenUntil: null, errorStreak: 0 })
      .where(and(eq(connections.id, id), eq(connections.workspaceId, workspaceId)))
      .returning();
    return this.present(row!);
  }

  /** Hard-delete (MN-252 AC) — no soft-delete/tombstone for credentials. */
  async remove(workspaceId: string, id: string) {
    const deleted = await this.db
      .delete(connections)
      .where(and(eq(connections.id, id), eq(connections.workspaceId, workspaceId)))
      .returning({ id: connections.id });
    if (deleted.length === 0) throw new NotFoundException('Connection not found');
    return { deleted: true };
  }

  async test(workspaceId: string, id: string) {
    const row = await this.requireRow(workspaceId, id);
    const descriptor = this.requireProvider(row.provider);
    const auth: unknown = JSON.parse(open(row.authSealed));
    try {
      await descriptor.healthCheck(auth, this.fetcher);
      await this.db
        .update(connections)
        .set({ status: 'active', lastOkAt: new Date(), errorStreak: 0 })
        .where(eq(connections.id, id));
      return { ok: true };
    } catch (error) {
      await this.db
        .update(connections)
        .set({ status: 'error', errorStreak: sql`${connections.errorStreak} + 1` })
        .where(eq(connections.id, id));
      throw error instanceof UnprocessableEntityException
        ? error
        : new UnprocessableEntityException(`${descriptor.label} check failed: ${String(error)}`);
    }
  }

  /**
   * MN-253 — the `connectionAuth` helper handed to every JobRunnerService
   * executor. Throws NotFoundException if the connection is gone or belongs
   * to a different workspace; executors re-validate at run time since a
   * connection can be deleted after a rule was saved (validate() only checks
   * at save time).
   */
  async getDecryptedAuth(workspaceId: string, connectionId: string): Promise<{ provider: string; auth: unknown }> {
    const row = await this.requireRow(workspaceId, connectionId);
    return { provider: row.provider, auth: JSON.parse(open(row.authSealed)) };
  }

  private async requireRow(workspaceId: string, id: string): Promise<ConnectionRow> {
    const row = await this.db.query.connections.findFirst({
      where: and(eq(connections.id, id), eq(connections.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('Connection not found');
    return row;
  }

  /** 404, not 400 — an unrecognized provider id is "no such resource in the
   * registry", the same shape as requireRow/requireOAuthProvider/requireEnv
   * below, not a malformed request. */
  private requireProvider(id: string): ProviderDescriptor {
    const descriptor = PROVIDER_REGISTRY.get(id);
    if (!descriptor) throw new NotFoundException(`Unknown provider "${id}"`);
    return descriptor;
  }

  private requireOAuthProvider(id: string): ProviderDescriptor {
    const descriptor = this.requireProvider(id);
    if (descriptor.authKind !== 'oauth2' || !descriptor.oauth) {
      throw new NotFoundException(`"${id}" does not support OAuth connect`);
    }
    return descriptor;
  }

  private requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new NotFoundException(`${name} is not configured on this server`);
    return value;
  }

  // ── OAuth2 ───────────────────────────────────────────────────────────────

  callbackUrl(): string {
    return `${env().API_URL}/api/v1/connections/oauth/callback`;
  }

  /** 302 target for "Connect" on an oauth2 provider. Throws 404 if the
   * provider is unknown, isn't oauth2, or the server has no client id/secret. */
  authorizeUrl(workspaceId: string, provider: string, userId: string): string {
    const descriptor = this.requireOAuthProvider(provider);
    const clientId = this.requireEnv(descriptor.oauth!.clientIdEnv);
    this.requireEnv(descriptor.oauth!.clientSecretEnv); // fail fast if only half-configured
    const state = this.signState({ ws: workspaceId, provider, uid: userId, n: randomBytes(9).toString('base64url'), t: Date.now() });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.callbackUrl(),
      response_type: 'code',
      scope: descriptor.oauth!.scopes.join(' '),
      state,
      ...(descriptor.oauth!.extraAuthParams ?? {}),
    });
    return `${descriptor.oauth!.authUrl}?${params.toString()}`;
  }

  /** A tamper-proof, time-boxed `state` (HMAC-SHA256, BETTER_AUTH_SECRET) —
   * the callback is unauthenticated, so this is what proves the workspace,
   * provider and initiating admin, not any request-supplied value (CSRF). */
  private signState(payload: OAuthState): string {
    const data = base64url(JSON.stringify(payload));
    return `${data}.${this.stateHmac(data)}`;
  }

  /** Verify a returned `state`. Constant-time compare; rejects tamper and expiry. */
  verifyOAuthState(state: string | undefined): OAuthState | null {
    if (!state) return null;
    const dot = state.lastIndexOf('.');
    if (dot <= 0) return null;
    const data = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const expected = this.stateHmac(data);
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as OAuthState;
      if (!payload.ws || !payload.provider || !payload.uid || typeof payload.t !== 'number') return null;
      if (Date.now() - payload.t > STATE_MAX_AGE_MS) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private stateHmac(data: string): string {
    return createHmac('sha256', env().BETTER_AUTH_SECRET).update(data).digest('hex');
  }

  /** The callback's actual work: exchange `code`, seal the tokens, insert the row. */
  async completeOAuth(verified: OAuthState, code: string) {
    const descriptor = this.requireOAuthProvider(verified.provider);
    const clientId = this.requireEnv(descriptor.oauth!.clientIdEnv);
    const clientSecret = this.requireEnv(descriptor.oauth!.clientSecretEnv);
    const res = await this.fetcher(descriptor.oauth!.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.callbackUrl(),
      }).toString(),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`${descriptor.label} token exchange failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as OAuthTokenResponse;
    if (!body.access_token) {
      throw new UnprocessableEntityException(`${descriptor.label} token exchange returned no access token`);
    }
    const now = Date.now();
    const auth = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      token_type: body.token_type,
      scope: body.scope,
      obtained_at: now,
      expires_at: body.expires_in ? now + body.expires_in * 1000 : undefined,
    };
    const sealed = seal(JSON.stringify(auth));
    const [row] = await this.db
      .insert(connections)
      .values({
        workspaceId: verified.ws,
        provider: descriptor.id,
        name: descriptor.label,
        authSealed: sealed,
        scopes: descriptor.oauth!.scopes,
        status: 'active',
        lastOkAt: new Date(),
        createdBy: verified.uid,
      })
      .returning();
    return this.present(row!);
  }

  // ── refresh loop (Step 4) ────────────────────────────────────────────────

  /** Public for tests — normally driven by the 5-minute onModuleInit timer. */
  async refreshDueTokens(): Promise<void> {
    const rows = await this.db.query.connections.findMany({ where: eq(connections.status, 'active') });
    for (const row of rows) {
      const descriptor = PROVIDER_REGISTRY.get(row.provider);
      if (!descriptor || descriptor.authKind !== 'oauth2' || !descriptor.oauth) continue;
      await this.refreshOne(row, descriptor);
    }
  }

  private async refreshOne(row: ConnectionRow, descriptor: ProviderDescriptor): Promise<void> {
    let auth: { refresh_token?: string; expires_at?: number };
    try {
      auth = JSON.parse(open(row.authSealed)) as { refresh_token?: string; expires_at?: number };
    } catch (error) {
      this.logger.warn(`connection ${row.id}: could not decrypt auth for refresh check: ${String(error)}`);
      return;
    }
    if (!auth.expires_at || auth.expires_at - Date.now() > REFRESH_WINDOW_MS) return; // not due yet
    if (!auth.refresh_token) {
      await this.flagExpired(row);
      return;
    }
    try {
      const clientId = this.requireEnv(descriptor.oauth!.clientIdEnv);
      const clientSecret = this.requireEnv(descriptor.oauth!.clientSecretEnv);
      const res = await this.fetcher(descriptor.oauth!.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: auth.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as OAuthTokenResponse;
      if (!body.access_token) throw new Error('refresh response missing access_token');
      const now = Date.now();
      const refreshed = {
        ...auth,
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? auth.refresh_token,
        obtained_at: now,
        expires_at: body.expires_in ? now + body.expires_in * 1000 : undefined,
      };
      await this.db
        .update(connections)
        .set({ authSealed: seal(JSON.stringify(refreshed)), status: 'active', lastOkAt: new Date(), errorStreak: 0 })
        .where(eq(connections.id, row.id));
    } catch (error) {
      this.logger.warn(`connection ${row.id} (${row.provider}) refresh failed: ${String(error)}`);
      await this.flagExpired(row);
    }
  }

  // ── quota (#239) ─────────────────────────────────────────────────────────

  /**
   * #239 — daily API-quota guard shared by every source polling through one
   * connection (a workspace can point several sources at the same YouTube
   * connection). Returns false — and leaves `quotaState` untouched — when
   * consuming `units` would exceed `dailyBudget` for today; otherwise
   * consumes them and returns true. Scoped separately from the MN-253
   * `connectionRateState` token bucket on the same row: that one paces
   * outbound action calls with backoff; this one is a same-day usage ceiling
   * for scheduled polling, reset by day rollover rather than by refill rate.
   */
  async checkAndConsumeQuota(connectionId: string, units: number, dailyBudget: number): Promise<boolean> {
    const row = await this.db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
    if (!row) return false;
    const today = new Date().toISOString().slice(0, 10);
    const state = (row.quotaState ?? {}) as { date?: string; used?: number };
    const usedToday = state.date === today ? (state.used ?? 0) : 0;
    if (usedToday + units > dailyBudget) return false;
    await this.db
      .update(connections)
      .set({ quotaState: { date: today, used: usedToday + units } })
      .where(eq(connections.id, connectionId));
    return true;
  }

  private async flagExpired(row: ConnectionRow): Promise<void> {
    await this.db
      .update(connections)
      .set({ status: 'expired', errorStreak: sql`${connections.errorStreak} + 1` })
      .where(eq(connections.id, row.id));
    if (!row.createdBy) return;
    // Best-effort, like every other notify() producer — a notification failure
    // must never fail the refresh sweep.
    await this.notifications
      .notify({
        workspaceId: row.workspaceId,
        actorId: row.createdBy,
        type: 'connection_error',
        recipients: [row.createdBy],
        snippet: `${row.provider} connection "${row.name}" needs reconnecting`,
        allowSelf: true,
      })
      .catch(() => undefined);
  }
}
