import { describe, expect, it } from 'vitest';
import {
  LEGACY_DEFAULT_AUTH_SECRET,
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
