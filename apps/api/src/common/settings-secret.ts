import { open, seal } from './secretbox';

/**
 * Ticket #1239 — integration credentials kept in the workspace `settings` JSONB (Slack bot token / webhook URL, GitHub token /
 * webhook secret, Linear API key, the outbound webhook signing secret) are sealed at rest with the same secretbox as the
 * `connections` registry, so a database dump or backup no longer carries them in the clear.
 *
 * A sealed value stays a STRING in the blob (`sealed:v1.…`): presence checks (`Boolean(cfg.token)`), the redaction net (it keys
 * on the field name) and SQL like `->>'webhook_secret' IS NOT NULL` keep working unchanged. A value without the prefix is a legacy
 * plaintext one written before this change; it is read as-is and sealed by the next save (or by the boot-time backfill).
 */
const PREFIX = 'sealed:';

export function isSealedSetting(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Seal a credential for storage. Idempotent: an already-sealed value is returned untouched; empty/absent stays as it was. */
export function sealSetting<T extends string | undefined | null>(value: T): T {
  if (typeof value !== 'string' || value.length === 0 || isSealedSetting(value)) return value;
  return `${PREFIX}${seal(value)}` as T;
}

/** The plaintext of a stored credential, legacy plaintext included. Throws if a sealed value was tampered with or the key changed. */
export function openSetting<T extends string | undefined | null>(value: T): T {
  if (!isSealedSetting(value)) return value;
  return open(value.slice(PREFIX.length)) as T;
}

/** Return a copy of `obj` with the named fields sealed. */
export function sealFields<T extends object>(obj: T, fields: readonly (keyof T)[]): T {
  const out = { ...obj } as Record<keyof T, unknown>;
  for (const f of fields) out[f] = sealSetting(out[f] as string | undefined);
  return out as T;
}

/** Return a copy of `obj` with the named fields opened. */
export function openFields<T extends object>(obj: T, fields: readonly (keyof T)[]): T {
  const out = { ...obj } as Record<keyof T, unknown>;
  for (const f of fields) out[f] = openSetting(out[f] as string | undefined);
  return out as T;
}

/** Which `settings` sub-blob holds which credentials. The backfill walks exactly this list. */
export const SEALED_SETTING_FIELDS = {
  slack: ['bot_token', 'webhook_url'],
  github: ['token', 'webhook_secret'],
  linear: ['api_key'],
} as const;
/** A top-level `settings` key that is itself a credential. */
export const SEALED_TOP_LEVEL_SETTINGS = ['webhook_signing_secret'] as const;
