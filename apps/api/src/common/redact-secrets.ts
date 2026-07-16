/**
 * Redact secret-looking values before a payload leaves the API (MN-144).
 *
 * Integration credentials (Linear api_key, GitHub token, …) are stored inside the
 * workspace `settings` JSONB blob. Anything returned to a client — REST, the MCP,
 * activity — must run through this so a key can never surface in a response. Keys
 * are matched by normalized name, so new integrations are covered automatically;
 * non-secret siblings like `team_keys` / `repos` are preserved.
 */
const SECRET_KEYS = new Set([
  'apikey',
  'token',
  'bottoken',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'privatekey',
  'credential',
  'credentials',
  // A Slack incoming-webhook URL embeds a secret path, so treat it like a token.
  'webhookurl',
  // Signs button webhooks (MN-088); lives in settings, so it needs naming here —
  // "secret" alone doesn't match once it's prefixed.
  'webhooksigningsecret',
]);

const REDACTED = '[redacted]';

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) && v != null && v !== '' ? REDACTED : redactSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}
