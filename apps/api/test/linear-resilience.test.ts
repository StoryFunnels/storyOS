import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher } from './helpers/linear-fake';
import { LinearService, defaultFetcher } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';
import { classifyLinearFailure, LinearApiError, rateLimitResetAtMs, safeLinearText, shrinkQuery, withLinearResilience } from '../src/integrations/linear-resilience';
import { pageAll } from '../src/integrations/linear-paging';

/**
 * Ticket #1392 — the Linear import reports what Linear actually said, waits out its rate limit, imports team by team and resumes.
 * Every response here is a HAND-WRITTEN fake in the documented shape (https://linear.app/developers/rate-limiting, read 2026-11-27):
 * nothing was recorded from the live API and no real key or data is used.
 */
const KEY = 'lin_api_FAKEKEYFAKEKEY';
const NOW = Date.UTC(2026, 10, 27, 14, 0, 0);
const body = (code: string, message: string, extra: Record<string, unknown> = {}) => JSON.stringify({ errors: [{ message, extensions: { code, ...extra } }] });
const failure = async (attempt: Promise<unknown>): Promise<LinearApiError> => {
  try { await attempt; } catch (e) { return e as LinearApiError; }
  throw new Error('expected the call to reject');
};
const headers = (h: Record<string, string>) => ({ get: (n: string) => Object.entries(h).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? null });

describe('#1392 the default fetcher reads Linear\'s body instead of blaming the key', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, text: string, h: Record<string, string> = {}) =>
    vi.stubGlobal('fetch', async () => new Response(text, { status, headers: h }));

  it('a 400 RATELIMITED is a rate limit with Linear\'s code, never "check the API key" (this was the bug)', async () => {
    answer(400, body('RATELIMITED', 'Rate limit exceeded'), { 'X-RateLimit-Requests-Remaining': '0', 'X-RateLimit-Requests-Reset': String(NOW + 90_000) });
    const err = await failure(defaultFetcher('query Teams { x }', {}, KEY));
    expect(err).toBeInstanceOf(LinearApiError);
    expect(err.kind).toBe('rate_limited');
    expect(err.message).toContain('RATELIMITED');
    expect(err.message).not.toMatch(/check the API key|key is valid/);
    expect(err.resetAtMs).toBe(NOW + 90_000);
  });

  it('a 429 is the same; a 400 about complexity is a complexity error; a 5xx is a server error; none say "key"', async () => {
    answer(429, body('RATELIMITED', 'slow down'), { 'Retry-After': '30' });
    expect(await defaultFetcher('q', {}, KEY).catch((e) => e)).toMatchObject({ kind: 'rate_limited' });
    answer(400, body('GRAPHQL_VALIDATION_FAILED', 'Query too complex: complexity 12000 exceeds the maximum of 10000'));
    const complex = await failure(defaultFetcher('q', {}, KEY));
    expect(complex.kind).toBe('complexity');
    expect(complex.message).not.toMatch(/API key/);
    answer(503, '<html>Service Unavailable</html>');
    const server = await failure(defaultFetcher('q', {}, KEY));
    expect(server.kind).toBe('server');
    expect(server.message).not.toMatch(/API key/);
  });

  it('only a real 401 says the key is wrong; a 403 says the key is valid but refused; another 4xx shows Linear\'s own message', async () => {
    answer(401, body('AUTHENTICATION_ERROR', 'Authentication required, not authenticated'));
    const auth = await failure(defaultFetcher('q', {}, KEY));
    expect(auth.kind).toBe('auth');
    expect(auth.message).toMatch(/rejected the API key.*check that the key is valid/);
    answer(403, body('FORBIDDEN', 'The key does not have the read scope'));
    const forbidden = await failure(defaultFetcher('q', {}, KEY));
    expect(forbidden.kind).toBe('forbidden');
    expect(forbidden.message).toMatch(/refused this request/);
    expect(forbidden.message).not.toMatch(/rejected the API key/);
    answer(400, body('INVALID_INPUT', 'Argument Validation Error: filter is malformed'));
    const bad = await failure(defaultFetcher('q', {}, KEY));
    expect(bad.message).toContain('Argument Validation Error: filter is malformed');
    expect(bad.message).not.toMatch(/API key/);
    answer(404, '');
    expect((await failure(defaultFetcher('q', {}, KEY))).kind).toBe('not_found');
  });

  it('the CODE decides, not Linear\'s wording: RATELIMITED with a message that never says "rate limit" is still a rate limit', async () => {
    answer(400, body('RATELIMITED', 'Too many requests, please slow down'));
    expect(await defaultFetcher('q', {}, KEY).catch((e) => e)).toMatchObject({ kind: 'rate_limited' });
  });

  it('a RATELIMITED inside a 200 body is a rate limit too; a dropped connection is a network error', async () => {
    answer(200, body('RATELIMITED', 'Rate limit exceeded'));
    expect(await defaultFetcher('q', {}, KEY).catch((e) => e)).toMatchObject({ kind: 'rate_limited' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const net = await failure(defaultFetcher('q', {}, KEY));
    expect(net.kind).toBe('network');
    expect(net.message).toContain('Could not reach Linear');
  });

  it('what Linear says is shown as data: the key is redacted, control characters and length are cut, and no header is echoed', () => {
    const err = classifyLinearFailure({ status: 400, bodyText: body('X', `bad ${KEY} \n\u0007${'y'.repeat(900)}`), headers: headers({ authorization: KEY }), apiKey: KEY });
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('FAKEKEY');
    expect(Array.from(err.message).some((ch) => ch.charCodeAt(0) < 32)).toBe(false);
    expect(err.message.length).toBeLessThan(500);
    expect(safeLinearText('lin_api_abc123 hello')).toBe('[redacted] hello');
  });
});

describe('#1392 reset headers', () => {
  it('Retry-After (seconds) wins; otherwise the reset of the exhausted bucket (epoch ms); epoch seconds are tolerated', () => {
    expect(rateLimitResetAtMs(headers({ 'Retry-After': '20', 'X-RateLimit-Requests-Reset': String(NOW + 999_000) }), NOW)).toBe(NOW + 20_000);
    expect(rateLimitResetAtMs(headers({ 'X-RateLimit-Requests-Remaining': '5', 'X-RateLimit-Requests-Reset': String(NOW + 5_000), 'X-RateLimit-Complexity-Remaining': '0', 'X-RateLimit-Complexity-Reset': String(NOW + 40_000) }), NOW)).toBe(NOW + 40_000);
    expect(rateLimitResetAtMs(headers({ 'X-RateLimit-Requests-Remaining': '0', 'X-RateLimit-Requests-Reset': String(Math.floor((NOW + 8_000) / 1000)) }), NOW)).toBe(Math.floor((NOW + 8_000) / 1000) * 1000);
    expect(rateLimitResetAtMs(headers({}), NOW)).toBeNull();
  });
});

/** A clock and a sleep that advance together, so no test waits. */
function clock() {
  const state = { now: NOW, sleeps: [] as number[] };
  return {
    state,
    options: { now: () => state.now, random: () => 0, sleep: async (ms: number) => { state.sleeps.push(ms); state.now += ms; } },
  };
}
const limited = (resetInMs: number, code = 'RATELIMITED') => new LinearApiError(`Linear's rate limit was reached (HTTP 400 ${code})`, { kind: 'rate_limited', status: 400, code, resetAtMs: NOW + resetInMs });

describe('#1392 the retry policy (injected clock, no real sleeping)', () => {
  it('a RATELIMITED waits until the reset header, then retries and succeeds - and is never an error to the caller', async () => {
    const c = clock();
    let calls = 0;
    const waits: Array<unknown> = [];
    const f = withLinearResilience(async () => { if (++calls === 1) throw limited(20_000); return { ok: true }; }, { ...c.options, onWait: (w) => { waits.push(w); } });
    expect(await f('q', {}, KEY)).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(c.state.sleeps).toEqual([21_000]); // reset 20s away + 1s margin (jitter is 0 here)
    expect(waits[0]).toMatchObject({ code: 'RATELIMITED', message: "Waiting for Linear's rate limit to reset; resumes at 14:00 UTC" });
    expect(waits[1]).toBeNull();
  });

  it('a reset further away than one run may wait ends as PAUSED with the time, not as a failure to import; the total is bounded too', async () => {
    const c = clock();
    const f = withLinearResilience(async () => { throw limited(40 * 60_000); }, { ...c.options });
    const err = await failure(f('q', {}, KEY));
    expect(err.paused).toBe(true);
    expect(err.message).toMatch(/Paused: Linear's rate limit is used up until 14:40 UTC \(RATELIMITED\)/);
    expect(err.message).toMatch(/already imported is kept/);
    expect(c.state.sleeps).toEqual([]);

    const total = clock();
    const g = withLinearResilience(async () => { throw new LinearApiError('limited', { kind: 'rate_limited', status: 400, code: 'RATELIMITED', resetAtMs: total.state.now + 9 * 60_000 }); }, { ...total.options, maxTotalWaitMs: 20 * 60_000 });
    const second = await failure(g('q', {}, KEY));
    expect(second.paused).toBe(true);
    expect(total.state.sleeps.length, 'two 9-minute waits fit in 20, the third does not').toBe(2);
  });

  it('a wait can be cancelled', async () => {
    const ac = new AbortController();
    const f = withLinearResilience(async () => { throw limited(5_000); }, { now: () => NOW, random: () => 0, signal: ac.signal, sleep: async (_ms, signal) => { ac.abort(); if (signal?.aborted) throw new Error('cancelled'); } });
    await expect(f('q', {}, KEY)).rejects.toThrow('cancelled');
  });

  it('a 5xx or dropped connection is retried with backoff, then fails clearly; a real 401 is never retried', async () => {
    const c = clock();
    let calls = 0;
    const server = new LinearApiError('Linear is having trouble (HTTP 503)', { kind: 'server', status: 503 });
    const flaky = withLinearResilience(async () => { if (++calls < 3) throw server; return 'ok'; }, { ...c.options });
    expect(await flaky('q', {}, KEY)).toBe('ok');
    expect(c.state.sleeps).toEqual([1000, 2000]);

    const down = withLinearResilience(async () => { calls++; throw server; }, { ...clock().options });
    calls = 0;
    const err = await failure(down('q', {}, KEY));
    expect(calls).toBe(4);
    expect(err.message).toMatch(/gave up after 4 attempts; nothing is wrong with the API key/);

    calls = 0;
    const auth = withLinearResilience(async () => { calls++; throw new LinearApiError('rejected', { kind: 'auth', status: 401 }); }, { ...clock().options });
    await expect(auth('q', {}, KEY)).rejects.toThrow('rejected');
    expect(calls).toBe(1);
  });

  it('a generic error from the inner fetcher passes through untouched', async () => {
    const f = withLinearResilience(async () => { throw new Error('boom'); }, { ...clock().options });
    await expect(f('q', {}, KEY)).rejects.toThrow('boom');
  });

  it('paces to the per-minute budget: the 31st request in a minute waits for the first to leave the window, and none is dropped', async () => {
    const c = clock();
    let calls = 0;
    const f = withLinearResilience(async () => ++calls, { ...c.options, requestsPerMinute: 30 });
    for (let i = 0; i < 31; i++) await f('q', {}, KEY);
    expect(calls).toBe(31);
    expect(c.state.sleeps).toHaveLength(1);
    expect(c.state.sleeps[0]).toBe(60_000);
    // and a slow caller (one a minute) is never held back
    const slow = clock();
    const g = withLinearResilience(async () => 1, { ...slow.options, requestsPerMinute: 30 });
    for (let i = 0; i < 40; i++) { await g('q', {}, KEY); slow.state.now += 61_000; }
    expect(slow.state.sleeps).toEqual([]);
  });
});

describe('#1392 a too-complex page is retried with fewer rows, not failed', () => {
  const query = 'query TeamIssues($id: String!, $after: String) { team(id: $id) { issues(first: 50, after: $after) { nodes { id labels(first: 50) { nodes { id } } } pageInfo { hasNextPage endCursor } } } }';
  const all = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}` }));
  const serve = (maxFirst: number, seen: number[]): LinearFetcher => async (q, v) => {
    const first = Number(/first: (\d+)/.exec(q)![1]);
    seen.push(first);
    if (first > maxFirst) throw new LinearApiError('Linear rejected a query as too complex (HTTP 400)', { kind: 'complexity', status: 400 });
    const start = v['after'] ? Number(v['after']) : 0;
    const nodes = all.slice(start, start + first);
    return { team: { issues: { nodes, pageInfo: { hasNextPage: start + nodes.length < all.length, endCursor: String(start + nodes.length) } } } };
  };
  const pick = (d: { team: { issues: never } }) => d.team.issues;

  it('halves the page until Linear accepts it, keeps that size, and returns every row exactly once', async () => {
    const seen: number[] = [];
    const rows = await pageAll<{ id: string }>(serve(20, seen), KEY, query, { id: 't' }, pick as never, 'issues');
    expect(rows.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(seen).toEqual([50, 25, 12, 12, 12, 12]);
  });

  it('shrinkQuery only touches the first (outer) connection and stops at a floor', () => {
    expect(shrinkQuery(query)).toContain('issues(first: 25,');
    expect(shrinkQuery(query)).toContain('labels(first: 50)');
    expect(shrinkQuery('x(first: 2)')).toBeNull();
  });

  it('a page that is too complex even at the floor fails with Linear\'s words, not a bad-key message', async () => {
    await expect(pageAll(serve(0, []), KEY, query, { id: 't' }, pick as never, 'issues of ENG')).rejects.toThrow(/too complex.*issues of ENG/s);
  });
});

/* ------------------------------------------------------------------ the service, five teams ------------------------------------------------------------------ */

const KEYS = ['ISSUE', 'QUA', 'PRO', 'UXC', 'INT'];
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const teamIssues = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({
  id: `${key}-iss-${i}`, identifier: `${key}-${i + 1}`, title: `${key} issue ${i + 1}`, description: null,
  url: `https://linear.app/acme/issue/${key}-${i + 1}`, estimate: null, priority: 0,
  state: { type: 'unstarted', name: 'Todo' }, labels: { nodes: [] }, assignee: null, parent: null, cycle: null, project: null,
}));
const fiveTeams = () => KEYS.map((key, i) => ({ id: `team-${key}`, key, name: key, data: { ...empty, issues: { nodes: teamIssues(key, 3 + i) } } }));
const EXPECTED_ISSUES = 3 + 4 + 5 + 6 + 7;

describe('#1392 through the service: five teams, rate limited partway, resumed', () => {
  let app: NestFastifyApplication;
  let linear: LinearService;
  let admin: { token: string };
  let ws: string;
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  const sleeps: number[] = [];
  let now = NOW;

  beforeAll(async () => {
    app = await createTestApp();
    linear = app.get(LinearService);
    linear.clock = () => now;
    linear.random = () => 0;
    linear.requestsPerMinute = 1_000_000; // pacing has its own test above; here it would only add sleeps
    linear.sleep = async (ms) => { sleeps.push(ms); now += ms; };
    admin = await signUpUser(app, 'Linear Resilience');
    ws = (await inject('POST', '/workspaces', { name: 'Linear Resilience WS' })).json().id;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: KEY, team_keys: KEYS })).statusCode).toBe(201);
  }, 120_000);
  afterAll(async () => { await app.close(); });

  const issueCount = async () => {
    const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceName?: string }>;
    let total = 0;
    for (const d of dbs.filter((x) => x.name === 'Issues')) {
      total += (await inject('POST', `/workspaces/${ws}/databases/${d.id}/records/aggregate`, { op: 'count' })).json().value as number;
    }
    return total;
  };
  const status = async () => (await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().sync;
  /** The queries the fake served, so a test can see which team was read. */
  const served: Array<{ q: string; id: unknown }> = [];
  const rawFetcher = (rule: (q: string, v: Record<string, unknown>) => void): LinearFetcher => {
    const base = makeLinearFetcher(fiveTeams()).fetcher;
    return async (q, v, k) => { served.push({ q: String(q.match(/query (\w+)/)?.[1]), id: v['id'] }); rule(q, v); return base(q, v, k); };
  };
  const readsOf = (teamId: string) => served.filter((s) => s.id === teamId && /^Team(Issues|Comments|Labels)$/.test(s.q)).length;

  it('a rate limit too long to wait out PAUSES the run: earlier teams are kept, the status says until when, and the message is Linear\'s', async () => {
    served.length = 0;
    linear.fetcher = rawFetcher((q, v) => { if (v['id'] === 'team-PRO' && q.includes('query TeamIssues(')) throw limited(40 * 60_000); });
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('RATELIMITED');
    expect(res.body).toContain('Paused');
    expect(res.body).toContain('team PRO');
    expect(res.body).not.toMatch(/check the API key/);
    expect(await issueCount(), 'ISSUE and QUA (3 + 4) were written and kept; PRO was not started').toBe(3 + 4);
    const s = await status();
    expect(s.paused).toMatchObject({ code: 'RATELIMITED', until: new Date(NOW + 40 * 60_000).toISOString() });
    expect(s.progress).toMatchObject({ teams_done: ['ISSUE', 'QUA'], teams_total: KEYS });
    expect(s.waiting).toBeNull();
    expect(s.last_error).toMatch(/team PRO: Paused/);
    expect(sleeps, 'it did not sit and wait 40 minutes').toEqual([]);
  }, 120_000);

  it('the re-run reads ONLY the teams not yet done, creates nothing twice, and clears the paused state', async () => {
    served.length = 0;
    linear.fetcher = rawFetcher(() => undefined);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().resumed).toMatchObject({ skipped_teams: ['ISSUE', 'QUA'] });
    expect(readsOf('team-ISSUE') + readsOf('team-QUA'), 'the finished teams were not read again').toBe(0);
    expect(readsOf('team-PRO')).toBeGreaterThan(0);
    expect(res.json().per_team.map((t: { key: string }) => t.key)).toEqual(['PRO', 'UXC', 'INT']);
    expect(await issueCount(), 'every issue exactly once').toBe(EXPECTED_ISSUES);
    const s = await status();
    expect(s.paused).toBeNull();
    expect(s.progress).toBeNull();
    expect(s.last_run).toMatchObject({ issues: 5 + 6 + 7 });
  }, 120_000);

  it('KEPT: a re-run of a COMPLETED import reads every team and creates nothing', async () => {
    served.length = 0;
    linear.fetcher = rawFetcher(() => undefined);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().resumed).toBeNull();
    expect(res.json().per_team).toHaveLength(5);
    expect(await issueCount()).toBe(EXPECTED_ISSUES);
  }, 120_000);

  it('a rate limit SHORT enough to wait out is waited out inside the run, shown while it lasts, and the run completes in one go', async () => {
    sleeps.length = 0;
    served.length = 0;
    let thrown = false;
    let duringWait: unknown = 'unset';
    linear.sleep = async (ms) => {
      sleeps.push(ms);
      duringWait = (await status()).waiting;
      now += ms;
    };
    linear.fetcher = rawFetcher((q, v) => { if (!thrown && v['id'] === 'team-QUA' && q.includes('query TeamIssues(')) { thrown = true; throw limited(15_000); } });
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(sleeps).toEqual([16_000]);
    expect(duringWait).toMatchObject({ code: 'RATELIMITED', message: expect.stringMatching(/Waiting for Linear's rate limit to reset; resumes at 14:\d\d UTC/) });
    expect((await status()).waiting).toBeNull();
    expect(await issueCount()).toBe(EXPECTED_ISSUES);
  }, 120_000);

  it('a real 401 says the key is wrong, and is recorded as the run\'s error', async () => {
    linear.fetcher = async () => { throw new LinearApiError('Linear rejected the API key (HTTP 401 AUTHENTICATION_ERROR) — check that the key is valid and has not been revoked', { kind: 'auth', status: 401, code: 'AUTHENTICATION_ERROR' }); };
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/rejected the API key/);
    expect((await status()).last_error).toMatch(/rejected the API key/);
  }, 60_000);

  it('the PREVIEW of all five teams reads counts only, in under 30 requests, and says what it did not read', async () => {
    served.length = 0;
    linear.fetcher = rawFetcher(() => undefined);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    const preview = res.json();
    expect(preview.counts_only).toBe(true);
    expect(served.length).toBeLessThan(30);
    expect(preview.requests).toBe(served.length);
    expect(preview.teams.map((t: { key: string; issues: number }) => [t.key, t.issues])).toEqual(KEYS.map((k, i) => [k, 3 + i]));
    expect(preview.teams[0]).toMatchObject({ comments: null, projects: null, sprints: null });
    expect(preview.not_read).toEqual(expect.arrayContaining(['comments', 'relations', 'attachments']));
    expect(served.some((s) => s.q === 'TeamIssues' || s.q === 'TeamComments' || s.q === 'TeamIssueHistory'), 'no issue, comment or history was walked').toBe(false);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run?detail=bogus`)).statusCode).toBe(400);
  }, 60_000);
});
