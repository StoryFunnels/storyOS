import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';

/**
 * #553 — "what commit is this deployment serving," API half. Also a
 * regression guard for the empty-string-vs-null bug this ticket's own
 * verification caught: Docker's `ENV GIT_SHA=$GIT_SHA` DEFINES the var (as
 * an empty string) even when the build arg was never passed, so a real
 * image never actually has it `undefined` — only ever `""`.
 *
 * Unit-level, not a full app boot: `env()` memoizes its parse on first call
 * (config/env.ts), so exercising each env scenario needs a genuinely fresh
 * module instance per case — `vi.resetModules()` + a dynamic re-import,
 * rather than mutating `process.env` against an already-booted app whose
 * `env()` cache was frozen at its own first call.
 */
describe('AppController#health — build info', () => {
  const original = { GIT_SHA: process.env.GIT_SHA, BUILD_TIME: process.env.BUILD_TIME };

  afterEach(() => {
    if (original.GIT_SHA === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = original.GIT_SHA;
    if (original.BUILD_TIME === undefined) delete process.env.BUILD_TIME;
    else process.env.BUILD_TIME = original.BUILD_TIME;
    vi.resetModules();
  });

  async function health() {
    vi.resetModules();
    const { AppController } = await import('../src/app.controller');
    return new AppController().health();
  }

  it('a real commit sha and build time pass through', async () => {
    process.env.GIT_SHA = 'deadbeef123';
    process.env.BUILD_TIME = '2026-09-07T12:34:56Z';
    const body = await health();
    expect(body.commit_sha).toBe('deadbeef123');
    expect(body.build_time).toBe('2026-09-07T12:34:56Z');
  });

  it('an EMPTY STRING (the self-built, no-build-args case) reports null, not ""', async () => {
    process.env.GIT_SHA = '';
    process.env.BUILD_TIME = '';
    const body = await health();
    expect(body.commit_sha).toBeNull();
    expect(body.build_time).toBeNull();
  });

  it('a genuinely absent var also reports null', async () => {
    delete process.env.GIT_SHA;
    delete process.env.BUILD_TIME;
    const body = await health();
    expect(body.commit_sha).toBeNull();
    expect(body.build_time).toBeNull();
  });
});

/**
 * #553 follow-up (Vera) — the bare `GET /` endpoint is genuinely unreachable
 * through the public single-origin Caddy proxy: docker/Caddyfile only
 * forwards `/api/*`, and app.setup.ts's setGlobalPrefix deliberately excludes
 * `/` from that prefix, so a public request to bare `/` never reaches this
 * container at all — it hits web's catch-all instead. `/build-info` has no
 * such exclusion, so it lands at `/api/v1/build-info`, reachable through the
 * exact same `/api/*` rule the rest of the API already relies on.
 *
 * A REAL app boot + real HTTP request, not a direct-instantiation unit test —
 * exactly the distinction that let the bare-`/` unreachability go unnoticed:
 * calling the controller method directly always "worked" regardless of what
 * path Nest actually registered it under.
 */
describe('GET /api/v1/build-info — reachable through the same prefix as the rest of the API', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('resolves under the /api/v1 prefix, unauthenticated, same shape as health()', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/build-info' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['build_time', 'commit_sha']);
  });

  it('the bare root health check still answers directly (unchanged, MUST KEEP WORKING)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
