import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env';

/**
 * Symmetric encryption-at-rest for the `connections` registry (MN-252). Every
 * external-provider credential (an Apify token, an OAuth access/refresh token
 * pair, a Resend key) is sealed with this before it touches a row, and opened
 * only in memory, immediately before use. Nothing here is Nest-specific so it
 * stays trivially unit-testable — mirrors webhook-sender.ts's "no framework in
 * the crypto" shape.
 *
 * Format: `v1.<iv b64>.<tag b64>.<ciphertext b64>` — versioned up front so a
 * future algorithm change (or a KMS-backed key) can add a `v2` branch without
 * a data migration; the version tag is never secret.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit, the GCM-recommended nonce size
const VERSION = 'v1';
const KEY_BYTES = 32; // AES-256

/** The resolved 32-byte key, decoded from the hex string `env().CONNECTIONS_MASTER_KEY`. */
function masterKey(): Buffer {
  const key = Buffer.from(env().CONNECTIONS_MASTER_KEY, 'hex');
  if (key.length !== KEY_BYTES) {
    // env() already validates the hex string's length at resolve time; this is
    // defense-in-depth against a hand-built env object (e.g. in a test).
    throw new Error(`secretbox: CONNECTIONS_MASTER_KEY must decode to ${KEY_BYTES} bytes`);
  }
  return key;
}

/**
 * Encrypt `plaintext` (typically `JSON.stringify(authObject)`) into the sealed
 * string stored in `connections.auth_sealed`. A fresh random IV every call —
 * GCM must never reuse an IV under the same key. `key` is overridable so unit
 * tests can exercise "wrong key" without touching process.env/the env() cache.
 */
export function seal(plaintext: string, key: Buffer = masterKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/**
 * Reverse of `seal`. Throws on any tamper (a flipped byte anywhere fails GCM's
 * auth-tag check) or on the wrong key — never silently returns garbage.
 */
export function open(sealed: string, key: Buffer = masterKey()): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('secretbox: malformed or unrecognized ciphertext version');
  }
  const [, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');
  const ciphertext = Buffer.from(ciphertextPart, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // GCM verifies the tag inside final() — a tampered ciphertext or a wrong key
  // (which produces a tag mismatch, not a decode error) both throw here.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
