import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { oauthAccessToken, session } from '../db/schema';
import { TokensService } from '../tokens/tokens.service';
import { RunnersService } from '../runners/runners.service';
import { RUNNER_TOKEN_PREFIX } from '../runners/runner.constants';

const PAT_BEARER_PREFIX = 'Bearer mn_pat_';
/** better-auth's session cookie, with or without the `__Secure-` prefix it gets over https. */
const SESSION_COOKIE = /^(?:__Secure-)?better-auth\.session_token$/;

/** The session token inside a better-auth value: a cookie carries `token.signature` (URL-encoded), a bearer may too. */
function sessionTokenOf(value: string): string | null {
  let v: string;
  try {
    v = decodeURIComponent(value);
  } catch {
    return null;
  }
  const token = v.split('.')[0] ?? '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

/** The session cookie's value from a raw Cookie header, or null. */
export function sessionCookieValue(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && SESSION_COOKIE.test(part.slice(0, eq).trim())) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Rate-limit keying (MN-248).
 *
 * The tracker must be something an attacker can't cheaply vary per request.
 * Keying on the raw `Authorization` header was exactly that bypass: a fresh
 * random `Bearer` per request minted a fresh bucket, so throttling never
 * engaged on the unauthenticated surface where it matters most (anonymous
 * `POST /public/forms/:token`, brute-forcing credentials).
 *
 * So:
 *  - A **resolved** PAT gets its own per-principal bucket, keyed on the token's
 *    sha256 identity — the same value tokens are already looked up by, so it's a
 *    stable identifier, not a new secret. Two different valid PATs stay
 *    independent; one caller can't burn another's budget.
 *  - An **unresolvable/invalid** token gets NO bucket of its own — it falls
 *    through to the IP bucket. This is the whole fix: bogus tokens can no longer
 *    scatter buckets.
 *  - #1043: a **resolved** session (cookie or bearer session token) or hosted-MCP
 *    **OAuth access token** gets a per-PERSON bucket, `user:<id>`. Before, these
 *    fell to the IP bucket, and every OAuth MCP user arrives from the same MCP
 *    container address, so they all shared one budget. A value that does not
 *    resolve to a live session/token gets no bucket of its own (same rule as a PAT).
 *  - **Anonymous** callers key on the client IP.
 *
 * This guard is the app's only global guard and runs before the per-controller
 * AuthGuard, so it can't read an already-resolved principal off the request — it
 * resolves the token itself, via a cheap read-only hash lookup.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly runners: RunnersService,
    @Inject(DB) private readonly db: Db,
  ) {
    super(options, storageService, reflector);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as FastifyRequest;
    const auth = request.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith(PAT_BEARER_PREFIX)) {
      const principal = await this.tokens.identify(auth.slice('Bearer '.length));
      if (principal) return `pat:${principal}`;
      // Invalid/revoked token: deliberately do NOT return here — fall through to
      // the IP bucket. Minting a per-token bucket for an unresolved token is the
      // bypass this guard exists to close.
    }
    // #1131 — a Runner heartbeats about every 30 s; many of them behind one office address must not share (and starve) one IP bucket.
    // Same rule as a PAT: only a token that resolves gets its own bucket, so a bogus one cannot scatter buckets.
    if (typeof auth === 'string' && auth.startsWith(`Bearer ${RUNNER_TOKEN_PREFIX}`)) {
      const principal = await this.runners.identify(auth.slice('Bearer '.length));
      if (principal) return `runner:${principal}`;
    }
    const person = await this.personFor(request, auth);
    if (person) return `user:${person}`;
    // request.ip is Fastify's trustProxy-aware client address. trustProxy is
    // pinned to the single front proxy (Caddy) in main.ts, so a client-supplied
    // X-Forwarded-For can't be spoofed to scatter buckets one layer up.
    return `ip:${request.ip ?? 'anonymous'}`;
  }

  /**
   * #1043: the user behind a live session (cookie or bearer) or a live hosted-MCP OAuth access token, or null. One indexed
   * lookup by the token (both columns are unique); AuthGuard still does the real validation afterwards. A PAT or Runner token
   * that did not resolve above is not retried here.
   */
  private async personFor(request: FastifyRequest, auth: string | undefined): Promise<string | null> {
    const now = new Date();
    let bearer: string | null = null;
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && !auth.startsWith(PAT_BEARER_PREFIX) && !auth.startsWith(`Bearer ${RUNNER_TOKEN_PREFIX}`)) {
      bearer = auth.slice('Bearer '.length).trim();
    }
    const cookie = sessionCookieValue(request.headers.cookie);
    for (const value of [bearer, cookie]) {
      const token = value ? sessionTokenOf(value) : null;
      if (!token) continue;
      const [row] = await this.db
        .select({ userId: session.userId })
        .from(session)
        .where(and(eq(session.token, token), gt(session.expiresAt, now)))
        .limit(1);
      if (row) return row.userId;
    }
    if (bearer && /^[A-Za-z0-9._~+/=-]{16,512}$/.test(bearer)) {
      const [row] = await this.db
        .select({ userId: oauthAccessToken.userId })
        .from(oauthAccessToken)
        .where(and(eq(oauthAccessToken.accessToken, bearer), gt(oauthAccessToken.accessTokenExpiresAt, now)))
        .limit(1);
      if (row?.userId) return row.userId;
    }
    return null;
  }
}
