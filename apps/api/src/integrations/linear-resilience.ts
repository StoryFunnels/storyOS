import { UnprocessableEntityException } from '@nestjs/common';
import type { LinearFetcher } from './linear.service';

/**
 * Ticket #1392 — what Linear actually said, and what to do about it.
 *
 * The fetcher used to throw "Linear API <status> — check the API key" for ANY non-OK status and discard the body, so a rate limit
 * (Linear answers it with 429, or with 400 and `errors[].extensions.code = RATELIMITED`) and a rejected-as-too-complex query both read
 * as a bad key. This file classifies a failed response by its body first and its status second, keeps the code and message, and
 * holds the retry policy (wait for the reset, back off on 5xx, give up cleanly) apart from the HTTP call so it can be tested with an
 * injected clock and no real sleeping.
 *
 * Header semantics are from Linear's rate-limiting docs (https://linear.app/developers/rate-limiting), read 2026-11-27, NOT observed
 * on the live API: `X-RateLimit-Requests-Reset` and `X-RateLimit-Complexity-Reset` are UTC epoch MILLISECONDS; `Retry-After` is seconds.
 */
export type LinearErrorKind = 'rate_limited' | 'complexity' | 'auth' | 'forbidden' | 'not_found' | 'server' | 'network' | 'bad_request' | 'graphql';

export interface LinearFailureInput {
  status: number | null;
  /** The raw response body text (may be empty or not JSON). */
  bodyText?: string;
  headers?: { get(name: string): string | null };
  /** Never echoed into a message: the key itself is redacted from anything Linear sent back. */
  apiKey?: string;
  /** For a failure that never reached an HTTP status (a dropped connection). */
  networkMessage?: string;
}

const MAX_TEXT = 300;

/** Linear's own words, made safe to show: control characters out, one line, bounded, and never the API key. */
export function safeLinearText(raw: unknown, apiKey?: string): string {
  let text = typeof raw === 'string' ? raw : '';
  if (apiKey) text = text.split(apiKey).join('[redacted]');
  text = text.replace(/lin_(?:api|oauth)_[A-Za-z0-9]+/g, '[redacted]');
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export class LinearApiError extends UnprocessableEntityException {
  readonly kind: LinearErrorKind;
  readonly httpStatus: number | null;
  /** Linear's `extensions.code` (RATELIMITED, AUTHENTICATION_ERROR, ...), when its body had one. */
  readonly code: string | null;
  /** Linear's `extensions.type`, when present. */
  readonly linearType: string | null;
  /** UTC epoch ms at which the exhausted limit comes back, from the response headers. Null = headers did not say. */
  readonly resetAtMs: number | null;
  /** Set only on the error that ENDS a run: the rate-limit wait was longer than this run may spend. */
  readonly paused: boolean;
  constructor(message: string, info: { kind: LinearErrorKind; status: number | null; code?: string | null; linearType?: string | null; resetAtMs?: number | null; paused?: boolean }) {
    super(message);
    this.kind = info.kind;
    this.httpStatus = info.status;
    this.code = info.code ?? null;
    this.linearType = info.linearType ?? null;
    this.resetAtMs = info.resetAtMs ?? null;
    this.paused = info.paused ?? false;
  }
  /** The same error under a different message (the sync prefixes the team), keeping everything a caller decides on. */
  withMessage(message: string): LinearApiError {
    return new LinearApiError(message, { kind: this.kind, status: this.httpStatus, code: this.code, linearType: this.linearType, resetAtMs: this.resetAtMs, paused: this.paused });
  }
}

interface ParsedBody { code: string | null; type: string | null; message: string; userMessage: string }

function parseBody(bodyText: string | undefined): ParsedBody | null {
  if (!bodyText) return null;
  try {
    const body = JSON.parse(bodyText.slice(0, 200_000)) as { errors?: Array<{ message?: unknown; extensions?: { code?: unknown; type?: unknown; userPresentableMessage?: unknown } }> };
    const first = body?.errors?.[0];
    if (!first) return null;
    const ext = first.extensions ?? {};
    return {
      code: typeof ext.code === 'string' ? ext.code : null,
      type: typeof ext.type === 'string' ? ext.type : null,
      message: typeof first.message === 'string' ? first.message : '',
      userMessage: typeof ext.userPresentableMessage === 'string' ? ext.userPresentableMessage : '',
    };
  } catch {
    return null;
  }
}

function headerNumber(headers: LinearFailureInput['headers'], name: string): number | null {
  const raw = headers?.get(name);
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Epoch ms from a reset header. Documented as milliseconds; a value too small to be a 2001+ millisecond epoch is read as seconds. */
const epochMs = (n: number | null): number | null => (n === null ? null : n < 1e11 ? n * 1000 : n);

/**
 * When the exhausted limit is back. `Retry-After` (seconds, relative) wins; else the reset of a bucket whose `remaining` is 0, or
 * - when no remaining count is readable - the later of the two resets (waiting for both is the only way to be sure).
 */
export function rateLimitResetAtMs(headers: LinearFailureInput['headers'], nowMs: number): number | null {
  const retryAfter = headerNumber(headers, 'retry-after');
  if (retryAfter !== null) return nowMs + retryAfter * 1000;
  const buckets = (['Requests', 'Complexity'] as const).map((b) => ({
    reset: epochMs(headerNumber(headers, `X-RateLimit-${b}-Reset`)),
    remaining: headerNumber(headers, `X-RateLimit-${b}-Remaining`),
  }));
  const exhausted = buckets.filter((b) => b.reset !== null && b.remaining !== null && b.remaining <= 0).map((b) => b.reset as number);
  if (exhausted.length > 0) return Math.max(...exhausted);
  const known = buckets.filter((b) => b.reset !== null && b.remaining === null).map((b) => b.reset as number);
  return known.length > 0 ? Math.max(...known) : null;
}

/** Turn a failed Linear response (or a body-level `errors` array on a 200) into a typed error that says what Linear said. */
export function classifyLinearFailure(input: LinearFailureInput, nowMs = Date.now()): LinearApiError {
  const { status, apiKey } = input;
  if (status === null) {
    return new LinearApiError(`Could not reach Linear (${safeLinearText(input.networkMessage ?? 'network error', apiKey) || 'network error'})`, { kind: 'network', status: null });
  }
  const body = parseBody(input.bodyText);
  const code = body?.code ?? null;
  const upper = (code ?? '').toUpperCase();
  const said = safeLinearText(body?.userMessage || body?.message, apiKey);
  const tag = `HTTP ${status}${code ? ` ${code}` : ''}`;
  const lower = `${said} ${body?.type ?? ''}`.toLowerCase();

  if (status === 429 || upper === 'RATELIMITED' || /rate ?limit/.test(lower)) {
    const resetAtMs = rateLimitResetAtMs(input.headers, nowMs);
    return new LinearApiError(`Linear's rate limit was reached (${tag})${said ? `: ${said}` : ''}`, { kind: 'rate_limited', status, code, linearType: body?.type, resetAtMs });
  }
  if (status === 401 || upper === 'AUTHENTICATION_ERROR' || /authentication/.test(lower)) {
    return new LinearApiError(`Linear rejected the API key (${tag}) — check that the key is valid and has not been revoked${said ? `. Linear said: ${said}` : ''}`, { kind: 'auth', status, code, linearType: body?.type });
  }
  if (status === 403 || upper === 'FORBIDDEN' || /forbidden|scope|permission/.test(lower)) {
    return new LinearApiError(`Linear accepted the API key but refused this request (${tag}) — the key's user lacks access or a needed scope${said ? `. Linear said: ${said}` : ''}`, { kind: 'forbidden', status, code, linearType: body?.type });
  }
  if (/complex/.test(lower) || upper.includes('COMPLEX')) {
    return new LinearApiError(`Linear rejected a query as too complex (${tag})${said ? `: ${said}` : ''}`, { kind: 'complexity', status, code, linearType: body?.type });
  }
  if (status === 404) {
    return new LinearApiError(`Linear could not find what was asked for (${tag})${said ? `: ${said}` : ''}`, { kind: 'not_found', status, code, linearType: body?.type });
  }
  if (status >= 500) {
    return new LinearApiError(`Linear is having trouble (${tag})${said ? `: ${said}` : ''}`, { kind: 'server', status, code, linearType: body?.type });
  }
  if (status >= 400) {
    return new LinearApiError(`Linear rejected the request (${tag})${said ? `: ${said}` : ' with no message'}`, { kind: 'bad_request', status, code, linearType: body?.type });
  }
  // A 200 whose body carries `errors`: keep the long-standing "Linear API: <message>" wording.
  return new LinearApiError(`Linear API: ${said || 'unknown error'}${code ? ` (${code})` : ''}`, { kind: 'graphql', status, code, linearType: body?.type });
}

export const utcClock = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

export interface ResilienceOptions {
  /** Waits `ms`, or rejects at once when `signal` aborts. Injected so tests never really sleep. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** 0..1, for jitter. */
  random: () => number;
  signal?: AbortSignal;
  /** The longest ONE rate-limit wait may be; a reset further away ends the run as paused. */
  maxWaitMs?: number;
  /** The most a run may spend waiting on rate limits in total. */
  maxTotalWaitMs?: number;
  /** Tries for a 5xx / dropped connection (the first one included). */
  serverAttempts?: number;
  /** Called when a wait starts and when it ends (null), so the sync health can say what the run is doing. */
  onWait?: (wait: { resumeAtMs: number; code: string | null; message: string } | null) => void | Promise<void>;
}

export const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
export const DEFAULT_MAX_TOTAL_WAIT_MS = 25 * 60_000;
const DEFAULT_SERVER_ATTEMPTS = 4;
const RATE_LIMIT_ATTEMPTS = 25;
/** Waited when Linear says rate limited but no header says until when. */
const UNKNOWN_RESET_WAIT_MS = 30_000;

/**
 * Wrap a raw fetcher with the retry policy. A generic (non-Linear) error from the inner fetcher passes through untouched.
 * One wrapper per RUN: the total wait is that run's budget.
 */
export function withLinearResilience(inner: LinearFetcher, options: ResilienceOptions): LinearFetcher {
  const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxTotal = options.maxTotalWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS;
  const serverAttempts = options.serverAttempts ?? DEFAULT_SERVER_ATTEMPTS;
  let waited = 0;
  return async (query, variables, apiKey) => {
    let serverTries = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner(query, variables, apiKey);
      } catch (error) {
        if (!(error instanceof LinearApiError)) throw error;
        if (error.kind === 'rate_limited') {
          const now = options.now();
          const jitter = Math.floor(options.random() * 3000);
          const wait = (error.resetAtMs !== null ? Math.max(0, error.resetAtMs - now) : UNKNOWN_RESET_WAIT_MS) + 1000 + jitter;
          const resumeAtMs = now + wait;
          if (wait > maxWait || waited + wait > maxTotal || attempt >= RATE_LIMIT_ATTEMPTS) {
            const until = error.resetAtMs !== null ? ` until ${utcClock(error.resetAtMs)}` : '';
            throw new LinearApiError(
              `Paused: Linear's rate limit is used up${until} (${error.code ?? `HTTP ${error.httpStatus}`}). What was already imported is kept; run the import again after that time and it continues with the teams not yet done.`,
              { kind: 'rate_limited', status: error.httpStatus, code: error.code, linearType: error.linearType, resetAtMs: error.resetAtMs, paused: true },
            );
          }
          await options.onWait?.({ resumeAtMs, code: error.code, message: `Waiting for Linear's rate limit to reset; resumes at ${utcClock(resumeAtMs)}` });
          try {
            await options.sleep(wait, options.signal);
          } finally {
            waited += wait;
            await options.onWait?.(null);
          }
          continue;
        }
        if (error.kind === 'server' || error.kind === 'network') {
          serverTries++;
          if (serverTries >= serverAttempts) {
            throw new LinearApiError(`${error.message} — gave up after ${serverTries} attempts; nothing is wrong with the API key, try again shortly`, { kind: error.kind, status: error.httpStatus, code: error.code });
          }
          await options.sleep(Math.round(1000 * 2 ** (serverTries - 1) * (1 + options.random() * 0.25)), options.signal);
          continue;
        }
        throw error;
      }
    }
  };
}

/** Halve the top-level `first: N` of a query (the connection being walked); null once it cannot shrink further. */
export function shrinkQuery(query: string): string | null {
  const match = /first: (\d+)/.exec(query);
  if (!match) return null;
  const n = Number(match[1]);
  if (n <= 2) return null;
  return query.replace(/first: \d+/, `first: ${Math.max(1, Math.floor(n / 2))}`);
}
