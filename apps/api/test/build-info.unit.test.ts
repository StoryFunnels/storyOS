import { describe, expect, it, vi } from 'vitest';

/**
 * #553 — GIT_SHA/BUILD_TIME are baked into the Docker image at build time
 * (docker/api.Dockerfile's ARG) and read via config/env.ts's cached env().
 * `env()` memoizes into a module-level `cached` variable, so each test here
 * calls `vi.resetModules()` before its own dynamic import — otherwise the
 * FIRST test's cached result would leak into the second (isolation between
 * test FILES is vitest's default; isolation between tests IN one file is
 * not, and this module's whole point is a value that's fixed for the
 * process's lifetime).
 */
describe('#553 GIT_SHA/BUILD_TIME plumbing (env.ts)', () => {
  it('reads GIT_SHA and BUILD_TIME from process.env when set (the Docker-build case)', async () => {
    vi.resetModules();
    process.env.GIT_SHA = 'abc123def456';
    process.env.BUILD_TIME = '2026-09-07T01:00:00Z';
    const { env } = await import('../src/config/env');
    expect(env().GIT_SHA).toBe('abc123def456');
    expect(env().BUILD_TIME).toBe('2026-09-07T01:00:00Z');
  });

  it('is undefined, never a fabricated placeholder, when not set (the ordinary dev/test-boot case)', async () => {
    vi.resetModules();
    delete process.env.GIT_SHA;
    delete process.env.BUILD_TIME;
    const { env } = await import('../src/config/env');
    expect(env().GIT_SHA).toBeUndefined();
    expect(env().BUILD_TIME).toBeUndefined();
  });
});
