import { describe, expect, it } from 'vitest';
import {
  LEGACY_DEFAULT_AUTH_SECRET,
  assertS3Credentials,
  envSchema,
  resolveAuthSecret,
  resolveConnectionsMasterKey,
} from './env';

describe('resolveAuthSecret', () => {
  describe('production', () => {
    it('refuses to boot when the secret is unset', () => {
      expect(() => resolveAuthSecret('production', undefined)).toThrow(
        /refusing to boot in production/i,
      );
    });

    it('refuses the well-known legacy default', () => {
      expect(() =>
        resolveAuthSecret('production', LEGACY_DEFAULT_AUTH_SECRET),
      ).toThrow(/refusing to boot in production/i);
    });

    it('refuses a too-short secret', () => {
      expect(() => resolveAuthSecret('production', 'short')).toThrow(
        /refusing to boot in production/i,
      );
    });

    it('includes the generate command in the error', () => {
      expect(() => resolveAuthSecret('production', undefined)).toThrow(
        /openssl rand -hex 32/,
      );
    });

    it('accepts a strong explicit secret', () => {
      const secret = 'a'.repeat(32);
      expect(resolveAuthSecret('production', secret)).toBe(secret);
    });

    it('trims surrounding whitespace before validating', () => {
      const secret = 'b'.repeat(40);
      expect(resolveAuthSecret('production', `  ${secret}  `)).toBe(secret);
    });
  });

  describe('development / test', () => {
    it('uses the provided secret when set', () => {
      expect(resolveAuthSecret('development', 'my-dev-secret')).toBe(
        'my-dev-secret',
      );
    });

    it('generates a random per-boot secret when unset — never a shared constant', () => {
      const a = resolveAuthSecret('development', undefined);
      const b = resolveAuthSecret('development', undefined);
      expect(a).not.toBe('');
      expect(a).not.toBe(LEGACY_DEFAULT_AUTH_SECRET);
      expect(a).not.toBe(b); // per-boot randomness
      expect(a).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
    });

    it('does not throw in test env even with no secret', () => {
      expect(() => resolveAuthSecret('test', undefined)).not.toThrow();
    });
  });
});

// Regression coverage for the z.coerce.boolean() footgun: Boolean("false") is
// true in JS, so z.coerce.boolean() silently inverts an explicit "false" from
// .env/compose. RUN_MIGRATIONS and S3_FORCE_PATH_STYLE were both bitten by
// this; they must parse the literal strings "true"/"1" as true and everything
// else — including "false" — as false.
describe('envSchema boolean flags', () => {
  describe('RUN_MIGRATIONS (default false)', () => {
    it('defaults to false when unset', () => {
      expect(envSchema.parse({}).RUN_MIGRATIONS).toBe(false);
    });

    it('is true for "true"', () => {
      expect(envSchema.parse({ RUN_MIGRATIONS: 'true' }).RUN_MIGRATIONS).toBe(true);
    });

    it('is true for "1"', () => {
      expect(envSchema.parse({ RUN_MIGRATIONS: '1' }).RUN_MIGRATIONS).toBe(true);
    });

    it('is false for the literal string "false" — the coerce.boolean() footgun', () => {
      expect(envSchema.parse({ RUN_MIGRATIONS: 'false' }).RUN_MIGRATIONS).toBe(false);
    });

    it('is false for "0"', () => {
      expect(envSchema.parse({ RUN_MIGRATIONS: '0' }).RUN_MIGRATIONS).toBe(false);
    });
  });

  describe('S3_FORCE_PATH_STYLE (default true)', () => {
    it('defaults to true when unset', () => {
      expect(envSchema.parse({}).S3_FORCE_PATH_STYLE).toBe(true);
    });

    it('is true for "true"', () => {
      expect(envSchema.parse({ S3_FORCE_PATH_STYLE: 'true' }).S3_FORCE_PATH_STYLE).toBe(true);
    });

    it('is false for the literal string "false" — the coerce.boolean() footgun', () => {
      expect(envSchema.parse({ S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false);
    });

    it('is false for "0"', () => {
      expect(envSchema.parse({ S3_FORCE_PATH_STYLE: '0' }).S3_FORCE_PATH_STYLE).toBe(false);
    });
  });
});

// MN-252: the connections registry's encryption-at-rest key. Same shape of
// guarantee as resolveAuthSecret above, plus the dev/test HKDF-from-auth-secret
// fallback so a fresh checkout needs no new env var.
describe('resolveConnectionsMasterKey', () => {
  const STRONG_HEX = 'a'.repeat(64);
  const AUTH_SECRET = 'some-auth-secret-value';

  describe('production', () => {
    it('refuses to boot when the key is unset', () => {
      expect(() => resolveConnectionsMasterKey('production', undefined, AUTH_SECRET)).toThrow(
        /refusing to boot in production/i,
      );
    });

    it('refuses a value that is not 64 hex characters', () => {
      expect(() => resolveConnectionsMasterKey('production', 'too-short', AUTH_SECRET)).toThrow(
        /refusing to boot in production/i,
      );
      expect(() =>
        resolveConnectionsMasterKey('production', 'z'.repeat(64), AUTH_SECRET),
      ).toThrow(/refusing to boot in production/i); // 'z' isn't hex
    });

    it('includes the generate command in the error', () => {
      expect(() => resolveConnectionsMasterKey('production', undefined, AUTH_SECRET)).toThrow(
        /openssl rand -hex 32/,
      );
    });

    it('names the variable, and never echoes a rejected value (#1286)', () => {
      const secretish = 'hunter2-not-hex-but-someones-real-password';
      let message = '';
      try {
        resolveConnectionsMasterKey('production', secretish, AUTH_SECRET);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('CONNECTIONS_MASTER_KEY');
      expect(message).not.toContain(secretish);
      expect(message).not.toContain(AUTH_SECRET);
    });

    it('accepts a strong 64-char hex key', () => {
      expect(resolveConnectionsMasterKey('production', STRONG_HEX, AUTH_SECRET)).toBe(STRONG_HEX);
    });

    it('lowercases an uppercase hex key', () => {
      expect(resolveConnectionsMasterKey('production', STRONG_HEX.toUpperCase(), AUTH_SECRET)).toBe(
        STRONG_HEX,
      );
    });
  });

  describe('development / test', () => {
    it('uses an explicit valid hex key when set', () => {
      expect(resolveConnectionsMasterKey('development', STRONG_HEX, AUTH_SECRET)).toBe(STRONG_HEX);
    });

    it('derives a stable 64-char hex key from BETTER_AUTH_SECRET when unset', () => {
      const a = resolveConnectionsMasterKey('development', undefined, AUTH_SECRET);
      const b = resolveConnectionsMasterKey('development', undefined, AUTH_SECRET);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(a).toBe(b); // deterministic for the same auth secret
    });

    it('derives a different key for a different BETTER_AUTH_SECRET', () => {
      const a = resolveConnectionsMasterKey('development', undefined, 'secret-one');
      const b = resolveConnectionsMasterKey('development', undefined, 'secret-two');
      expect(a).not.toBe(b);
    });

    it('falls back to the derived key when the provided value is not valid hex', () => {
      const fallback = resolveConnectionsMasterKey('test', undefined, AUTH_SECRET);
      const withGarbage = resolveConnectionsMasterKey('test', 'not-hex-at-all', AUTH_SECRET);
      expect(withGarbage).toBe(fallback);
    });

    it('does not throw in test env even with no key', () => {
      expect(() => resolveConnectionsMasterKey('test', undefined, AUTH_SECRET)).not.toThrow();
    });
  });
});

describe('envSchema PDF renderer (#262 / #794)', () => {
  it('is OFF by default: no renderer URL means "not configured", never a guessed address', () => {
    const e = envSchema.parse({});
    expect(e.PDF_RENDERER_URL).toBeUndefined();
    expect(e.PDF_RENDER_TIMEOUT_MS).toBe(30_000);
    expect(e.PDF_RENDER_MAX_PENDING).toBe(4);
  });

  it('coerces the numeric knobs from the environment strings', () => {
    const e = envSchema.parse({ PDF_RENDER_TIMEOUT_MS: '45000', PDF_RENDER_MAX_PENDING: '2' });
    expect(e.PDF_RENDER_TIMEOUT_MS).toBe(45_000);
    expect(e.PDF_RENDER_MAX_PENDING).toBe(2);
  });

  it('refuses a timeout that would hang a request, or a queue that is unbounded', () => {
    expect(() => envSchema.parse({ PDF_RENDER_TIMEOUT_MS: '200' })).toThrow();
    expect(() => envSchema.parse({ PDF_RENDER_TIMEOUT_MS: '9999999' })).toThrow();
    expect(() => envSchema.parse({ PDF_RENDER_MAX_PENDING: '0' })).toThrow();
    expect(() => envSchema.parse({ PDF_RENDER_MAX_PENDING: '5000' })).toThrow();
  });
});

describe('assertS3Credentials (ticket #1045)', () => {
  it('refuses the s3 driver with no credentials, naming both variables', () => {
    expect(() => assertS3Credentials('s3', undefined, undefined)).toThrow(
      /S3_ACCESS_KEY and S3_SECRET_KEY are not set/,
    );
  });

  it('refuses an empty value and names only the missing one', () => {
    expect(() => assertS3Credentials('s3', 'my-key', '  ')).toThrow(/S3_SECRET_KEY is not set/);
  });

  it('refuses the old MinIO defaults', () => {
    expect(() => assertS3Credentials('s3', 'storyos', 'storyos-minio')).toThrow(
      /old built-in defaults/,
    );
  });

  it('refuses when only one half is still a default', () => {
    expect(() => assertS3Credentials('s3', 'my-key', 'storyos-minio')).toThrow(
      /old built-in defaults/,
    );
    expect(() => assertS3Credentials('s3', 'storyos', 'a-real-secret')).toThrow(
      /old built-in defaults/,
    );
  });

  it('accepts real credentials', () => {
    expect(() => assertS3Credentials('s3', 'AKIAREAL', 'a-real-secret-value')).not.toThrow();
  });

  it('does not touch the local-disk driver, whatever the S3 variables hold', () => {
    expect(() => assertS3Credentials('local', undefined, undefined)).not.toThrow();
    expect(() => assertS3Credentials('local', 'storyos', 'storyos-minio')).not.toThrow();
  });
});
