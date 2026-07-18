import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { TokensService } from '../tokens/tokens.service';

const PAT_BEARER_PREFIX = 'Bearer mn_pat_';

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
 *  - **Anonymous** callers (and session cookies, which a login attacker could
 *    equally vary) key on the real client IP.
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
    // request.ip is Fastify's trustProxy-aware client address. trustProxy is
    // pinned to the single front proxy (Caddy) in main.ts, so a client-supplied
    // X-Forwarded-For can't be spoofed to scatter buckets one layer up.
    return `ip:${request.ip ?? 'anonymous'}`;
  }
}
