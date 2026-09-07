import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

/**
 * #553 — regression guard for the empty-string-vs-null bug this ticket's own
 * verification caught: Docker's `ENV GIT_SHA=$GIT_SHA` DEFINES the var (as an
 * empty string) even when the build arg was never passed, so `process.env`
 * never actually has it `undefined` in a real image.
 */
describe('GET /build-info', () => {
  const original = { GIT_SHA: process.env.GIT_SHA, BUILD_TIME: process.env.BUILD_TIME };

  afterEach(() => {
    if (original.GIT_SHA === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = original.GIT_SHA;
    if (original.BUILD_TIME === undefined) delete process.env.BUILD_TIME;
    else process.env.BUILD_TIME = original.BUILD_TIME;
  });

  it('a real commit sha and build time pass through unchanged', async () => {
    process.env.GIT_SHA = 'deadbeef123';
    process.env.BUILD_TIME = '2026-09-07T12:34:56Z';
    const res = GET();
    const body = await res.json();
    expect(body).toEqual({ commit_sha: 'deadbeef123', build_time: '2026-09-07T12:34:56Z' });
  });

  it('an EMPTY STRING (the self-built, no-build-args case) reports null, not ""', async () => {
    process.env.GIT_SHA = '';
    process.env.BUILD_TIME = '';
    const res = GET();
    const body = await res.json();
    expect(body).toEqual({ commit_sha: null, build_time: null });
  });

  it('a genuinely absent var also reports null', async () => {
    delete process.env.GIT_SHA;
    delete process.env.BUILD_TIME;
    const res = GET();
    const body = await res.json();
    expect(body).toEqual({ commit_sha: null, build_time: null });
  });
});
