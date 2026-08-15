import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #316 — `apps/api/.env` must actually reach the API in development.
 *
 * The file existed and was ignored for the entire life of the project. It went
 * unnoticed because the zod defaults in `config/env.ts` match the documented
 * values exactly, so nothing looked wrong until someone needed a value that
 * DIFFERED — a scratch database, a real SMTP host — and their edit silently did
 * nothing.
 *
 * `loadDevEnvFile` reads `__dirname/../../.env`, which is not something a test
 * can point elsewhere, so these exercise the two properties that actually carry
 * the risk, against Node's loader directly:
 *
 *   1. an inline variable still beats the file (the test suite and the UAT
 *      launch config both pass DATABASE_URL inline and MUST keep winning), and
 *   2. production reads nothing.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'storyos-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STORYOS_PROBE;
  delete process.env.STORYOS_PROBE_INLINE;
});

describe('dev .env loading (#316)', () => {
  it('sets a variable that was not already present', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'STORYOS_PROBE=from-file\n');
    expect(process.env.STORYOS_PROBE).toBeUndefined();

    process.loadEnvFile(file);

    expect(process.env.STORYOS_PROBE).toBe('from-file');
  });

  it('NEVER overrides a variable already in the environment', () => {
    // The load-bearing one. `DATABASE_URL=… pnpm test` and the UAT launch config
    // both rely on this; if the file won, a stray .env would silently redirect
    // the test suite at the developer's real database.
    const file = join(dir, '.env');
    writeFileSync(file, 'STORYOS_PROBE_INLINE=from-file\n');
    process.env.STORYOS_PROBE_INLINE = 'from-inline';

    process.loadEnvFile(file);

    expect(process.env.STORYOS_PROBE_INLINE).toBe('from-inline');
  });

  it('resolves the package root from the BUILT layout (dist/config → ../..)', () => {
    // Guards the path arithmetic in loadDevEnvFile: __dirname is dist/config at
    // runtime, so the file sits two levels up. Off-by-one here would reintroduce
    // the bug silently, since a missing file is a no-op by design.
    const built = join(dir, 'dist', 'config');
    mkdirSync(built, { recursive: true });
    writeFileSync(join(dir, '.env'), 'STORYOS_PROBE=root-resolved\n');

    process.loadEnvFile(join(built, '..', '..', '.env'));

    expect(process.env.STORYOS_PROBE).toBe('root-resolved');
  });

  it('is a no-op in production, so a stray .env in an image cannot take effect', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { loadDevEnvFile } = await import('../src/config/load-env');
      expect(loadDevEnvFile()).toBeNull();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
