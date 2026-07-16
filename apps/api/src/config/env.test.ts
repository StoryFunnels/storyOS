import { describe, expect, it } from 'vitest';
import { LEGACY_DEFAULT_AUTH_SECRET, resolveAuthSecret } from './env';

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
