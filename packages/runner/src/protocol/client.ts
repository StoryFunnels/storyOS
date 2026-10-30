// SPDX-License-Identifier: Apache-2.0
import { API_PREFIX, PROTOCOL_VERSION } from './types.js';
import type {
  ClaimRequest,
  ClaimResponse,
  CompleteRequest,
  CompleteResponse,
  HeartbeatResponse,
  LeaseResponse,
  PairRequest,
  PairResponse,
  RunnerReport,
} from './types.js';

/** A failure the server ANSWERED: it has a status and, usually, a stable code the Runner can act on. */
export class RunnerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RunnerApiError';
  }
}

/** A failure to get an answer at all: the network dropped, the server is down, DNS, a timeout. Always safe to retry. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface ClientOptions {
  /** `https://app.storyos.dev` (no path). */
  server: string;
  token?: string;
  runnerVersion: string;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Give up on the whole request after this long. The claim long poll needs more than the server's 25 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The Runner's one HTTP client. Outbound only: every call is a request the Runner makes. It never logs a body, a header or a URL
 * with a credential in it, because it never builds one: the token travels only in the `Authorization` header.
 */
export class RunnerClient {
  private readonly base: string;
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly runnerVersion: string;

  constructor(options: ClientOptions) {
    this.base = options.server.replace(/\/+$/, '') + API_PREFIX;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runnerVersion = options.runnerVersion;
  }

  setToken(token: string): void {
    this.token = token;
  }

  pair(body: PairRequest, opts?: RequestOptions): Promise<PairResponse> {
    return this.post<PairResponse>('/pair', body, false, opts);
  }

  heartbeat(report: RunnerReport, opts?: RequestOptions): Promise<HeartbeatResponse> {
    return this.post<HeartbeatResponse>('/heartbeat', report, true, opts);
  }

  /** The long poll. `undefined` means the server answered 204: nothing queued. */
  async claim(body: ClaimRequest, opts?: RequestOptions): Promise<ClaimResponse | undefined> {
    const res = await this.post<ClaimResponse | undefined>('/claim', body, true, { timeoutMs: 45_000, ...opts });
    return res && Array.isArray(res.wakes) ? res : undefined;
  }

  leaseHeartbeat(wakeId: string, nonce: string, opts?: RequestOptions): Promise<LeaseResponse> {
    return this.post<LeaseResponse>(`/wakes/${encodeURIComponent(wakeId)}/heartbeat`, { nonce }, true, opts);
  }

  complete(wakeId: string, body: CompleteRequest, opts?: RequestOptions): Promise<CompleteResponse> {
    return this.post<CompleteResponse>(`/wakes/${encodeURIComponent(wakeId)}/complete`, body, true, opts);
  }

  private async post<T>(path: string, body: unknown, auth: boolean, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': `storyos-runner/${this.runnerVersion}`,
      'x-storyos-runner-protocol': String(PROTOCOL_VERSION),
    };
    if (auth) {
      if (!this.token) throw new RunnerApiError(401, 'invalid_runner_token', 'This Runner is not paired yet.');
      headers.authorization = `Bearer ${this.token}`;
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new NetworkError(networkMessage(e), e);
    }
    if (res.status === 204) return undefined as T;
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new NetworkError(networkMessage(e), e);
    }
    if (res.ok) {
      try {
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (e) {
        throw new NetworkError('The server sent a reply the Runner could not read.', e);
      }
    }
    throw toApiError(res.status, text);
  }
}

function networkMessage(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
  return `Could not reach the StoryOS server (${detail}).`;
}

function toApiError(status: number, text: string): RunnerApiError {
  let code = 'error';
  let message = `The server answered ${status}.`;
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string; meta?: Record<string, unknown> } };
    if (parsed.error) {
      if (typeof parsed.error.code === 'string') code = parsed.error.code;
      if (typeof parsed.error.message === 'string') message = parsed.error.message;
      if (parsed.error.meta && typeof parsed.error.meta === 'object') meta = parsed.error.meta;
    }
  } catch {
    // an HTML error page from a proxy: keep the generic sentence, never echo the body
  }
  return new RunnerApiError(status, code, message, meta);
}

/** A 5xx or a 429 is the server being unwell, not the Runner being wrong: retry. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (e instanceof RunnerApiError) return e.status >= 500 || e.status === 429 || e.status === 408;
  return false;
}
