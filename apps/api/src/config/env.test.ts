import { describe, expect, it } from 'vitest';
import { LEGACY_DEFAULT_AUTH_SECRET, envSchema, resolveAuthSecret } from './env';

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
