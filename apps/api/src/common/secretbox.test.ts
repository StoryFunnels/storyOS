import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env';

vi.mock('../config/env', () => ({ env: vi.fn() }));

import { env } from '../config/env';
import { open, seal } from './secretbox';

const mockEnv = vi.mocked(env);
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

function envWith(overrides: Partial<Env>): Env {
  return { CONNECTIONS_MASTER_KEY: KEY_A.toString('hex'), ...overrides } as Env;
}

describe('secretbox (MN-252)', () => {
  beforeEach(() => {
    mockEnv.mockReset();
    mockEnv.mockReturnValue(envWith({}));
  });

  it('round-trips a plaintext through seal/open', () => {
    const plaintext = JSON.stringify({ api_key: 'sk_live_abc123' });
    const sealed = seal(plaintext);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed.split('.')).toHaveLength(4);
    expect(sealed).not.toContain('sk_live_abc123');
    expect(open(sealed)).toBe(plaintext);
  });

  it('produces a different ciphertext every call (random IV)', () => {
    const plaintext = 'same plaintext';
    expect(seal(plaintext)).not.toBe(seal(plaintext));
  });

  it('throws when the ciphertext is tampered with', () => {
    const sealed = seal('super secret token');
    const [version, iv, tag, ciphertext] = sealed.split('.');
    // Flip the last base64 character of the ciphertext segment.
    const tampered = ciphertext!.slice(0, -1) + (ciphertext!.endsWith('A') ? 'B' : 'A');
    const corrupted = [version, iv, tag, tampered].join('.');
    expect(() => open(corrupted)).toThrow();
  });

  it('throws when the auth tag is tampered with', () => {
    const sealed = seal('super secret token');
    const [version, iv, tag, ciphertext] = sealed.split('.');
    const tamperedTag = tag!.slice(0, -1) + (tag!.endsWith('A') ? 'B' : 'A');
    const corrupted = [version, iv, tamperedTag, ciphertext].join('.');
    expect(() => open(corrupted)).toThrow();
  });

  it('throws when opened with the wrong key', () => {
    const sealed = seal('super secret token', KEY_A);
    expect(() => open(sealed, KEY_B)).toThrow();
  });

  it('throws on a malformed sealed string', () => {
    expect(() => open('not-a-sealed-value')).toThrow(/malformed/);
    expect(() => open('v2.a.b.c')).toThrow(/malformed/);
  });

  it('explicit key params round-trip independently of the env-resolved key', () => {
    const sealed = seal('explicit key value', KEY_B);
    expect(open(sealed, KEY_B)).toBe('explicit key value');
    expect(() => open(sealed)).toThrow(); // default (env-resolved) key is KEY_A here
  });
});
