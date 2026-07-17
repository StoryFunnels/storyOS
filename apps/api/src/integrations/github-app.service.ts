import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

/**
 * GitHub App layer (#247) — the deferred half of #42.
 *
 * This is the ONE place that turns the registered App's private key into a
 * usable credential. Both the PR backlink (AC 5) and any future App-authenticated
 * call go through `installationToken()`; nothing else should ever hold the PEM or
 * mint a JWT.
 *
 * ## Why the credentials are read live from `process.env`, not the zod `env()`
 *
 * The App vars are **optional and hot-togglable**: absent → the Connect feature
 * is simply unavailable and the existing manual `webhook_secret` + PAT path is
 * untouched (a deploy without GitHub configured must still boot). Keeping them
 * out of the cached, boot-time-validated `env()` schema is deliberate — they can
 * never contribute to a boot failure, and a test can toggle them per-case.
 *
 * ## The private key
 *
 * `GITHUB_APP_PRIVATE_KEY` arrives one of two ways:
 *  - inline: dotenv can't hold real newlines, so the PEM comes as a single line
 *    with literal `\n`, which we expand back to real newlines before signing;
 *  - a file: Docker-secret deploys mount the PEM as a file — set
 *    `GITHUB_APP_PRIVATE_KEY_FILE` (preferred) or point `GITHUB_APP_PRIVATE_KEY`
 *    itself at an existing path and we read it from disk.
 *
 * The PEM and every installation token are secrets: they are never logged.
 */

export interface GithubAppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

/** A minted, time-boxed installation token. */
interface CachedToken {
  token: string;
  /** Epoch ms at which GitHub expires it. */
  expiresAt: number;
}

/** The CSRF-signed state carried through the OAuth round-trip. */
interface StatePayload {
  /** Workspace the admin started the connect from. */
  ws: string;
  /** Random nonce — makes each state single-use-ish and unguessable. */
  n: string;
  /** Issued-at, epoch ms. */
  t: number;
}

/**
 * Minimal fetch surface so the service is testable without a network — mirrors
 * `SlackFetcher`. Every test injects a shim; NO test may reach api.github.com.
 */
export type GithubAppFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

const GITHUB_API = 'https://api.github.com';
const OAUTH_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const OAUTH_TOKEN = 'https://github.com/login/oauth/access_token';

/** Refresh an installation token this long before GitHub's stated expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Clock-skew the App-JWT `iat` back this far (GitHub's own guidance). */
const IAT_SKEW_SEC = 60;
/** App JWT lifetime — GitHub caps it at 10 min; we use 9 to stay inside. */
const JWT_TTL_SEC = 9 * 60;
/** A connect `state` older than this is rejected on return. */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const defaultFetcher: GithubAppFetcher = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body });

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

@Injectable()
export class GithubAppService {
  private readonly logger = new Logger(GithubAppService.name);
  /** Swappable in tests (fake fetcher). */
  fetcher: GithubAppFetcher = defaultFetcher;
  /** Swappable clock in tests (drive cache expiry without real time). */
  now: () => number = () => Date.now();

  /** installation id → cached token. Never logged, never returned to a client. */
  private readonly tokenCache = new Map<number, CachedToken>();

  /**
   * The App credentials, or `null` when the App isn't configured. Read live from
   * `process.env` (see the class comment) and resolves the PEM from `\n`-encoded
   * inline value or a file path.
   */
  credentials(): GithubAppCredentials | null {
    const appId = process.env.GITHUB_APP_ID?.trim();
    const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
    const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
    const privateKey = this.resolvePrivateKey();
    if (!appId || !clientId || !clientSecret || !privateKey) return null;
    return { appId, clientId, clientSecret, privateKey };
  }

  isConfigured(): boolean {
    return this.credentials() !== null;
  }

  /**
   * Resolve the signing PEM. Order: an explicit `_FILE`, then a
   * `GITHUB_APP_PRIVATE_KEY` that happens to be a path to a real file, then the
   * inline value with literal `\n` expanded. Any read/parse trouble yields `null`
   * (feature unavailable) rather than a throw — the App is optional.
   */
  private resolvePrivateKey(): string | null {
    try {
      const file = process.env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
      if (file && existsSync(file)) return readFileSync(file, 'utf8');
      const raw = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
      if (!raw) return null;
      if (!raw.includes('BEGIN') && existsSync(raw)) return readFileSync(raw, 'utf8');
      return raw.replace(/\\n/g, '\n');
    } catch (error) {
      this.logger.warn(`github app: could not read private key: ${String(error)}`);
      return null;
    }
  }

  // ── App JWT → installation token ─────────────────────────────────────────────

  /**
   * A short-lived RS256 App JWT (GitHub's spec): `iss` = App ID, `iat` skewed
   * back 60s, `exp` ≤ 10 min out. Signed with the PEM. Public so the token-minter
   * test can verify it against the public half of a **test** key.
   */
  mintAppJwt(creds: GithubAppCredentials): string {
    const nowSec = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({ iat: nowSec - IAT_SKEW_SEC, exp: nowSec + JWT_TTL_SEC, iss: creds.appId }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(creds.privateKey);
    return `${signingInput}.${base64url(signature)}`;
  }

  /**
   * A valid installation token for `installationId`, minted on demand and cached
   * until ~5 min before GitHub expires it. The token is a bearer credential for
   * the installation — it is never logged and never leaves the server.
   */
  async installationToken(installationId: number): Promise<string> {
    const creds = this.requireConfigured();
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - this.now() > REFRESH_SKEW_MS) return cached.token;

    const jwt = this.mintAppJwt(creds);
    const res = await this.fetcher(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      { method: 'POST', headers: this.jwtHeaders(jwt) },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub App token exchange failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) throw new Error('GitHub App token response missing token');
    const expiresAt = Date.parse(body.expires_at);
    this.tokenCache.set(installationId, { token: body.token, expiresAt });
    // Diagnostics only — installation id + expiry, deliberately NOT the token.
    this.logger.debug(`github app: minted installation token for ${installationId}, expires ${body.expires_at}`);
    return body.token;
  }

  /** Authenticated call as the installation. Mints/refreshes the token as needed. */
  private async appFetch(
    installationId: number,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
    const token = await this.installationToken(installationId);
    return this.fetcher(`${GITHUB_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'storyos',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  // ── Repo picker (AC: in-app repo picker) ─────────────────────────────────────

  /** Every repo the installation can see (`GET /installation/repositories`, paginated). */
  async listRepos(installationId: number): Promise<Array<{ full_name: string; private: boolean }>> {
    const perPage = 100;
    const out: Array<{ full_name: string; private: boolean }> = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.appFetch(
        installationId,
        'GET',
        `/installation/repositories?per_page=${perPage}&page=${page}`,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`GitHub App repo list failed (HTTP ${res.status})`);
      }
      const body = (await res.json()) as {
        repositories?: Array<{ full_name: string; private?: boolean }>;
      };
      const repos = body.repositories ?? [];
      for (const r of repos) out.push({ full_name: r.full_name, private: Boolean(r.private) });
      if (repos.length < perPage) break;
    }
    return out;
  }

  // ── Backlink (AC 5) ──────────────────────────────────────────────────────────

  /** Post a backlink comment on a PR. Returns GitHub's comment id (as a string). */
  async postComment(
    installationId: number,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<string> {
    const res = await this.appFetch(
      installationId,
      'POST',
      `/repos/${repo}/issues/${prNumber}/comments`,
      { body },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub App comment post failed (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { id?: number | string };
    if (json.id === undefined || json.id === null) throw new Error('GitHub comment response missing id');
    return String(json.id);
  }

  /** Update the previously-posted backlink comment (idempotent re-link path). */
  async updateComment(
    installationId: number,
    repo: string,
    commentId: string,
    body: string,
  ): Promise<void> {
    const res = await this.appFetch(
      installationId,
      'PATCH',
      `/repos/${repo}/issues/comments/${commentId}`,
      { body },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub App comment update failed (HTTP ${res.status})`);
    }
  }

  // ── OAuth connect + CSRF state ───────────────────────────────────────────────

  /** The redirect target GitHub returns to after install/authorize. */
  callbackUrl(): string {
    return `${env().API_URL}/api/v1/integrations/github/oauth/callback`;
  }

  /**
   * The GitHub install/authorize URL for the connect flow. For a GitHub App,
   * `login/oauth/authorize?client_id=…` shows the install screen and returns to
   * the callback with `installation_id` (+ a `code` when user-authorization is
   * enabled). The `state` is our signed CSRF token.
   */
  authorizeUrl(state: string): string {
    const creds = this.requireConfigured();
    const params = new URLSearchParams({
      client_id: creds.clientId,
      state,
      redirect_uri: this.callbackUrl(),
    });
    return `${OAUTH_AUTHORIZE}?${params.toString()}`;
  }

  /**
   * A tamper-proof, time-boxed `state` binding the connect to a workspace. Signed
   * with the server session secret (HMAC-SHA256). The callback is unauthenticated,
   * so this signature — not any request-supplied ws id — is what proves the
   * workspace the admin actually started from (CSRF).
   */
  signState(workspaceId: string): string {
    const payload: StatePayload = { ws: workspaceId, n: randomBytes(9).toString('base64url'), t: this.now() };
    const data = base64url(JSON.stringify(payload));
    return `${data}.${this.stateHmac(data)}`;
  }

  /** Verify a returned `state`; returns the bound workspace id, or null. */
  verifyState(state: string | undefined): { workspaceId: string } | null {
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
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as StatePayload;
      if (!payload.ws || typeof payload.t !== 'number') return null;
      if (this.now() - payload.t > STATE_MAX_AGE_MS) return null;
      return { workspaceId: payload.ws };
    } catch {
      return null;
    }
  }

  private stateHmac(data: string): string {
    return createHmac('sha256', env().BETTER_AUTH_SECRET).update(data).digest('hex');
  }

  /**
   * Exchange the OAuth `code` for a user-to-server token. Best-effort: it confirms
   * the user authorized, but the App's functionality runs on the installation
   * token, not this one — so a failure here never blocks capturing `installation_id`.
   */
  async exchangeCode(code: string): Promise<boolean> {
    return (await this.exchangeCodeForToken(code)) !== null;
  }

  /** Exchange the OAuth `code` for a user-to-server access token, or null. */
  async exchangeCodeForToken(code: string): Promise<string | null> {
    const creds = this.requireConfigured();
    const res = await this.fetcher(OAUTH_TOKEN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'storyos' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code }),
    });
    if (res.status < 200 || res.status >= 300) return null;
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  }

  /**
   * Installation ids of THIS App that the authorizing user can access
   * (`GET /user/installations` — automatically scoped to our App by the token).
   */
  async listUserInstallations(userToken: string): Promise<number[]> {
    const res = await this.fetcher(`${GITHUB_API}/user/installations?per_page=100`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${userToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'storyos',
      },
    });
    if (res.status < 200 || res.status >= 300) return [];
    const json = (await res.json()) as { installations?: Array<{ id: number }> };
    return (json.installations ?? []).map((i) => i.id).filter((id) => Number.isInteger(id) && id > 0);
  }

  /**
   * Resolve the installation to link from an OAuth `code`. GitHub's user-auth flow
   * (`login/oauth/authorize`) returns a `code`, NOT an `installation_id` — only the
   * separate installation flow does — so we exchange the code for a user token and
   * ask which installations of this App that user can reach. Returns the first, or
   * null if the user authorized but has not installed the App on any account yet.
   */
  async resolveInstallationFromCode(code: string): Promise<number | null> {
    const token = await this.exchangeCodeForToken(code);
    if (!token) return null;
    const ids = await this.listUserInstallations(token);
    return ids[0] ?? null;
  }

  private jwtHeaders(jwt: string): Record<string, string> {
    return {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'storyos',
    };
  }

  private requireConfigured(): GithubAppCredentials {
    const creds = this.credentials();
    if (!creds) throw new Error('GitHub App is not configured');
    return creds;
  }
}
