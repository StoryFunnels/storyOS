import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { GithubAppService } from '../src/integrations/github-app.service';
import type { GithubAppFetcher } from '../src/integrations/github-app.service';
import { GithubService } from '../src/integrations/github.service';

// ── A throwaway RSA key, generated in-test. NEVER a real key. ──────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_ID = '246810';
const CLIENT_ID = 'Iv1.test-client';
const CLIENT_SECRET = 'test-client-secret';

/** Configure the App via process.env (read live by the service). */
function configureApp() {
  process.env.GITHUB_APP_ID = APP_ID;
  process.env.GITHUB_APP_CLIENT_ID = CLIENT_ID;
  process.env.GITHUB_APP_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  delete process.env.GITHUB_APP_PRIVATE_KEY_FILE;
}
function unconfigureApp() {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_CLIENT_ID;
  delete process.env.GITHUB_APP_CLIENT_SECRET;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_APP_PRIVATE_KEY_FILE;
}

function okResponse(body: unknown, status = 200) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

// ══ UNIT: the token minter, JWT, CSRF state, repo list ════════════════════════
describe('GithubAppService (unit)', () => {
  beforeAll(configureApp);
  afterAll(unconfigureApp);

  describe('private key resolution', () => {
    afterEach(configureApp);

    it('expands a single-line PEM with literal \\n back to real newlines', () => {
      const oneLine = privateKey.replace(/\n/g, '\\n');
      expect(oneLine).not.toContain('\n');
      process.env.GITHUB_APP_PRIVATE_KEY = oneLine;
      const creds = new GithubAppService().credentials();
      expect(creds).not.toBeNull();
      expect(creds!.privateKey).toBe(privateKey);
    });

    it('reads the PEM from a file when GITHUB_APP_PRIVATE_KEY_FILE points at one', () => {
      const dir = mkdtempSync(join(tmpdir(), 'gh-app-'));
      const file = join(dir, 'key.pem');
      writeFileSync(file, privateKey);
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      process.env.GITHUB_APP_PRIVATE_KEY_FILE = file;
      const creds = new GithubAppService().credentials();
      expect(creds!.privateKey).toBe(privateKey);
    });

    it('is unconfigured (null) when nothing is set — feature simply unavailable', () => {
      unconfigureApp();
      expect(new GithubAppService().isConfigured()).toBe(false);
      expect(new GithubAppService().credentials()).toBeNull();
    });
  });

  describe('App JWT → installation token', () => {
    it('mints a valid RS256 JWT that verifies against the public key', () => {
      const svc = new GithubAppService();
      const nowMs = 1_700_000_000_000;
      svc.now = () => nowMs;
      const jwt = svc.mintAppJwt(svc.credentials()!);
      const [header, payload, signature] = jwt.split('.');
      // Signature verifies against the PUBLIC half of the test key.
      const verified = createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature!, 'base64url'));
      expect(verified).toBe(true);

      const h = JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'));
      const p = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
      expect(h).toEqual({ alg: 'RS256', typ: 'JWT' });
      expect(p.iss).toBe(APP_ID);
      const nowSec = Math.floor(nowMs / 1000);
      expect(p.iat).toBe(nowSec - 60); // clock-skewed back 60s
      expect(p.exp - p.iat).toBeLessThanOrEqual(600); // ≤ 10 min
      expect(p.exp).toBeGreaterThan(nowSec);
    });

    it('caches the installation token and refreshes only near expiry — never logging it', async () => {
      const svc = new GithubAppService();
      const base = 1_700_000_000_000;
      let clock = base;
      svc.now = () => clock;

      let minted = 0;
      const tokens: string[] = [];
      svc.fetcher = async (url, init) => {
        expect(url).not.toMatch(/api\.github\.com\/(?!app\/)/); // only the token endpoint
        expect(init.method).toBe('POST');
        minted += 1;
        const token = `ghs_secret_token_${minted}`;
        tokens.push(token);
        return okResponse({ token, expires_at: new Date(clock + 3_600_000).toISOString() });
      };

      // Capture everything the logger could emit.
      const logs: string[] = [];
      const sinks = ['debug', 'log', 'warn', 'error', 'verbose'] as const;
      const spies = sinks.map((m) =>
        vi.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(' '));
        }),
      );
      const consoleSpy = vi
        .spyOn(console, 'log')
        .mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));

      try {
        const t1 = await svc.installationToken(42);
        expect(minted).toBe(1);

        // Still fresh → served from cache, no new mint.
        const t2 = await svc.installationToken(42);
        expect(t2).toBe(t1);
        expect(minted).toBe(1);

        // Advance to inside the 5-min refresh window → exactly one refresh.
        clock = base + 3_600_000 - 200_000;
        const t3 = await svc.installationToken(42);
        expect(minted).toBe(2);
        expect(t3).not.toBe(t1);

        // The token must never appear in any log line.
        const haystack = logs.join('\n');
        for (const token of tokens) expect(haystack).not.toContain(token);
        // …and something WAS logged, so the assertion isn't vacuous.
        expect(logs.some((l) => l.includes('installation token for 42'))).toBe(true);
      } finally {
        spies.forEach((s) => s.mockRestore());
        consoleSpy.mockRestore();
      }
    });
  });

  describe('OAuth CSRF state', () => {
    it('round-trips a workspace id through a signed state', () => {
      const svc = new GithubAppService();
      const state = svc.signState('ws-abc');
      expect(svc.verifyState(state)).toEqual({ workspaceId: 'ws-abc' });
    });

    it('rejects a tampered state', () => {
      const svc = new GithubAppService();
      const state = svc.signState('ws-abc');
      const tampered = `${state.slice(0, -1)}${state.at(-1) === 'a' ? 'b' : 'a'}`;
      expect(svc.verifyState(tampered)).toBeNull();
    });

    it('rejects an absent state and an expired one', () => {
      const svc = new GithubAppService();
      expect(svc.verifyState(undefined)).toBeNull();
      let clock = 1_700_000_000_000;
      svc.now = () => clock;
      const state = svc.signState('ws-abc');
      clock += 11 * 60 * 1000; // older than the 10-min window
      expect(svc.verifyState(state)).toBeNull();
    });
  });

  describe('repo list', () => {
    it('paginates /installation/repositories via the installation token', async () => {
      const svc = new GithubAppService();
      const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `acme/r${i}`, private: false }));
      svc.fetcher = async (url) => {
        if (url.includes('/access_tokens')) {
          return okResponse({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
        }
        const page = Number(url.match(/[?&]page=(\d+)/)?.[1]);
        if (page === 1) return okResponse({ repositories: page1 });
        if (page === 2) return okResponse({ repositories: [{ full_name: 'acme/last', private: true }] });
        throw new Error(`unexpected ${url}`);
      };
      const repos = await svc.listRepos(7);
      expect(repos).toHaveLength(101);
      expect(repos.at(-1)).toEqual({ full_name: 'acme/last', private: true });
    });
  });

  describe('resolve installation from OAuth code', () => {
    // The bug this pins: login/oauth/authorize returns a `code`, never an
    // installation_id — so the callback must resolve the installation via the code.
    it('exchanges the code and returns the first installation of this App', async () => {
      const svc = new GithubAppService();
      const seen: string[] = [];
      svc.fetcher = async (url, init) => {
        seen.push(url);
        if (url.includes('/login/oauth/access_token')) return okResponse({ access_token: 'ghu_user' });
        if (url.includes('/user/installations')) {
          expect(init.headers.authorization).toBe('Bearer ghu_user');
          return okResponse({ total_count: 1, installations: [{ id: 4242 }] });
        }
        throw new Error(`unexpected ${url}`);
      };
      expect(await svc.resolveInstallationFromCode('cd17dc')).toBe(4242);
      expect(seen.some((u) => u.includes('/user/installations'))).toBe(true);
    });

    it('returns null when the user authorized but installed nothing', async () => {
      const svc = new GithubAppService();
      svc.fetcher = async (url) => {
        if (url.includes('/login/oauth/access_token')) return okResponse({ access_token: 'ghu_user' });
        if (url.includes('/user/installations')) return okResponse({ total_count: 0, installations: [] });
        throw new Error(`unexpected ${url}`);
      };
      expect(await svc.resolveInstallationFromCode('cd17dc')).toBeNull();
    });

    it('returns null when the code exchange fails', async () => {
      const svc = new GithubAppService();
      svc.fetcher = async () => okResponse({ error: 'bad_verification_code' }, 200);
      expect(await svc.resolveInstallationFromCode('nope')).toBeNull();
    });
  });
});

// ══ INTEGRATION: connect / callback / repos / backlink over the real app ══════
describe('GitHub App connect (integration)', () => {
  let app: NestFastifyApplication;
  let admin: { token: string };
  let wsId: string; // used for connect / callback / repos
  let backWs: string; // used for the backlink flow
  let ticketsDbId: string;
  let stateApi: string;

  const SECRET = 'a-very-secret-webhook-key-247';

  function sign(body: string) {
    // Local HMAC to sign deliveries with the workspace secret.
    return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  }

  async function as(method: string, url: string, payload?: unknown) {
    return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  }

  function prPayload(opts: { action: string; number: number; branch: string; merged?: boolean }) {
    return {
      action: opts.action,
      repository: { full_name: 'acme/site' },
      pull_request: {
        number: opts.number,
        title: `PR #${opts.number}`,
        state: opts.merged ? 'closed' : 'open',
        merged: opts.merged ?? false,
        merged_at: opts.merged ? '2026-07-17T00:00:00Z' : null,
        draft: false,
        html_url: `https://github.com/acme/site/pull/${opts.number}`,
        body: null,
        user: { login: 'dana' },
        head: { ref: opts.branch, sha: 'deadbeef' },
      },
    };
  }

  async function deliver(event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/api/v1/integrations/github/webhook',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(body) },
      payload: body,
    });
  }

  // A shim standing in for api.github.com — counts App calls; hits nothing real.
  const calls = { token: 0, postComment: 0, patchComment: 0 };
  let commentResponder: () => ReturnType<typeof okResponse> = () => okResponse({ id: 555 });
  const appShim: GithubAppFetcher = async (url, init) => {
    if (url.includes('/access_tokens')) {
      calls.token += 1;
      return okResponse({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (/\/issues\/\d+\/comments$/.test(url) && init.method === 'POST') {
      calls.postComment += 1;
      return commentResponder();
    }
    if (/\/issues\/comments\/[^/]+$/.test(url) && init.method === 'PATCH') {
      calls.patchComment += 1;
      return okResponse({});
    }
    if (url.includes('/installation/repositories')) {
      return okResponse({ repositories: [{ full_name: 'acme/site', private: false }, { full_name: 'acme/api', private: true }] });
    }
    throw new Error(`unexpected app call ${init.method} ${url}`);
  };

  beforeAll(async () => {
    configureApp();
    app = await createTestApp();
    app.get(GithubAppService).fetcher = appShim;
    // The importer fetcher (checks lookups) must also stay off the network.
    app.get(GithubService).fetcher = async () => ({ state: 'pending' });
    admin = await signUpUser(app, 'AppConnector');
    wsId = (await as('POST', '/workspaces', { name: 'Connect WS' })).json().id;
    backWs = (await as('POST', '/workspaces', { name: 'Backlink WS' })).json().id;

    const spaceId = (await as('GET', `/workspaces/${backWs}/spaces`)).json()[0].id;
    ticketsDbId = (await as('POST', `/workspaces/${backWs}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
    const state = (
      await as('POST', `/workspaces/${backWs}/databases/${ticketsDbId}/fields`, {
        display_name: 'State',
        type: 'select',
        config: {},
        options: [{ label: 'In Progress' }, { label: 'Done' }],
      })
    ).json();
    stateApi = state.apiName;

    // Backlink workspace: secret + link db + a connected installation.
    await as('POST', `/workspaces/${backWs}/integrations/github`, { webhook_secret: SECRET, link_database_id: ticketsDbId });
    await app.get(GithubService).saveInstallationId(backWs, 99887766);
  });

  afterAll(async () => {
    await app.close();
    unconfigureApp();
  });

  it('connect 302s to GitHub with a signed state (admin only)', async () => {
    const res = await as('GET', `/workspaces/${wsId}/integrations/github/connect`);
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(location).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`);
    expect(location).toContain('state=');
  });

  it('callback with a bad state is rejected (CSRF)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/github/oauth/callback?state=forged&installation_id=42',
    });
    expect(res.statusCode).toBe(400);
  });

  it('callback with a good state captures + persists the installation id', async () => {
    const goodState = app.get(GithubAppService).signState(wsId);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/github/oauth/callback?state=${encodeURIComponent(goodState)}&installation_id=13572468`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain(`/w/${wsId}/settings/integrations/github`);

    const cfg = (await as('GET', `/workspaces/${wsId}/integrations/github`)).json();
    expect(cfg.connected).toBe(true);
    expect(cfg.installation_id).toBe(13572468);
  });

  it('lists the installation repos and stores a chosen subset', async () => {
    const list = (await as('GET', `/workspaces/${wsId}/integrations/github/repos`)).json();
    expect(list.repos.map((r: { full_name: string }) => r.full_name)).toEqual(['acme/site', 'acme/api']);

    await as('POST', `/workspaces/${wsId}/integrations/github`, { repos: ['acme/site'] });
    const cfg = (await as('GET', `/workspaces/${wsId}/integrations/github`)).json();
    expect(cfg.repos).toEqual(['acme/site']);
  });

  it('never returns an installation token from any config response', async () => {
    const res = await as('GET', `/workspaces/${wsId}/integrations/github`);
    expect(res.body).not.toContain('ghs_installation');
    expect(res.body).not.toContain('ghs_');
  });

  it('Sync runs off the installation token when connected — no PAT required', async () => {
    // wsId is connected (installation 13572468) with repos ['acme/site'] and has
    // NEVER had a PAT set. Sync must authenticate as the installation.
    const github = app.get(GithubService);
    const original = github.fetcher;
    const seenTokens: string[] = [];
    github.fetcher = async (path, token) => {
      seenTokens.push(token);
      if (path.includes('/issues') || path.includes('/pulls')) return [];
      return { state: 'pending' };
    };
    try {
      const res = await as('POST', `/workspaces/${wsId}/integrations/github/sync`);
      expect(res.statusCode, res.body).toBe(201);
      // Every GitHub read used the installation token from the App shim, not a PAT.
      expect(seenTokens.length).toBeGreaterThan(0);
      expect(seenTokens.every((t) => t === 'ghs_installation')).toBe(true);
    } finally {
      github.fetcher = original;
    }
  });

  describe('backlink (AC 5) — post exactly once', () => {
    it('posts one comment on first link, PATCHes (never re-POSTs) on redelivery', async () => {
      const ticket = (await as('POST', `/workspaces/${backWs}/databases/${ticketsDbId}/records`, { values: { name: 'Backlink me' } })).json();
      calls.postComment = 0;
      calls.patchComment = 0;

      const payload = prPayload({ action: 'opened', number: 700, branch: `story-${ticket.number}` });
      const first = await deliver('pull_request', payload);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().linked_record_id).toBe(ticket.id);
      expect(calls.postComment).toBe(1);

      // The comment id is stored on the PR record — the post-once guard.
      const dbs = (await as('GET', `/workspaces/${backWs}/databases`)).json();
      const pullsDb = dbs.find((d: { name: string }) => d.name === 'GitHub Pull Requests');
      const prs = (await as('GET', `/workspaces/${backWs}/databases/${pullsDb.id}/records?limit=100`)).json().data;
      const pr = prs.find((p: { values: Record<string, unknown> }) => p.values.number === 700);
      expect(pr.values.backlink_comment_id).toBe('555');

      // GitHub redelivers the identical event → update the existing comment, never a 2nd POST.
      const again = await deliver('pull_request', payload);
      expect(again.statusCode).toBe(200);
      expect(calls.postComment).toBe(1); // still one
      expect(calls.patchComment).toBe(1);
    });

    it('a failed backlink (403) is swallowed — inbound processing still succeeds', async () => {
      commentResponder = () => okResponse({ message: 'Forbidden' }, 403);
      try {
        const ticket = (await as('POST', `/workspaces/${backWs}/databases/${ticketsDbId}/records`, { values: { name: 'No perms' } })).json();
        calls.postComment = 0;
        const res = await deliver('pull_request', prPayload({ action: 'opened', number: 701, branch: `story-${ticket.number}` }), backWs);
        // Delivery still 200 and the state automation still ran.
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().state_applied).toBe('In Progress');
        expect((await as('GET', `/workspaces/${backWs}/databases/${ticketsDbId}/records/${ticket.id}`)).json().values[stateApi]).toBeTruthy();
        expect(calls.postComment).toBe(1); // it tried once, then gave up
      } finally {
        commentResponder = () => okResponse({ id: 555 });
      }
    });
  });

  describe('App vars absent → Connect cleanly unavailable', () => {
    it('connect and repos 404 when the App is not configured; boot/manual path unaffected', async () => {
      unconfigureApp();
      try {
        expect((await as('GET', `/workspaces/${wsId}/integrations/github/connect`)).statusCode).toBe(404);
        expect((await as('GET', `/workspaces/${wsId}/integrations/github/repos`)).statusCode).toBe(404);
        // The ordinary config endpoint still works — the manual path is untouched.
        expect((await as('GET', `/workspaces/${wsId}/integrations/github`)).statusCode).toBe(200);
      } finally {
        configureApp();
      }
    });
  });
});
