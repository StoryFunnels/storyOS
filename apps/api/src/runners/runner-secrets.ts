import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, RUNNER_TOKEN_PREFIX } from './runner.constants';

/** A fresh pairing code, drawn with a CSPRNG (never Math.random). */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  return code;
}

/**
 * What a person typed, made comparable: case and separators do not matter ("abc-234" is "ABC234"). Null when it cannot be a
 * code at all (wrong length, or a character outside the alphabet), which the caller counts as a failed guess like any other.
 */
export function normalizePairingCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

/**
 * The stored form of a code: an HMAC keyed by the server secret, so a copy of the table cannot be reversed by trying the 31^6
 * possible codes. Deterministic on purpose: the exchange finds the row BY this value.
 */
export function hashPairingCode(code: string): string {
  return createHmac('sha256', env().BETTER_AUTH_SECRET).update(`runner-pairing-code:${code}`).digest('hex');
}

export interface MintedRunnerToken {
  token: string;
  tokenHash: string;
  /** `mn_run_` + first 4 … last 4: the only recoverable fragment. */
  tokenPrefix: string;
}

export const hashRunnerToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function mintRunnerToken(): MintedRunnerToken {
  const secret = randomBytes(24).toString('base64url');
  const token = `${RUNNER_TOKEN_PREFIX}${secret}`;
  return { token, tokenHash: hashRunnerToken(token), tokenPrefix: `${RUNNER_TOKEN_PREFIX}${secret.slice(0, 4)}…${secret.slice(-4)}` };
}

/** Constant-time comparison of two hex digests of the same length. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
