/**
 * Redact secret-looking values before a payload leaves the API (MN-144).
 *
 * Integration credentials (Linear api_key, GitHub token, …) are stored inside the
 * workspace `settings` JSONB blob, and outbound-webhook credentials inside a
 * button/automation action's `headers` map. Anything returned to a client — REST,
 * the MCP, activity, a pack export — must run through this so a key can never
 * surface in a response.
 *
 * ## Why patterns and not a list
 *
 * This used to be a hand-maintained `Set` of exact key names, which failed silently
 * and *open*. The near-miss that motivated the rewrite: `webhook_secret` normalizes
 * to `webhooksecret`, which wasn't in the set, so `GET /workspaces/:ws` would have
 * served the GitHub webhook secret in plaintext with a green suite. It never
 * shipped — the key and its entry landed in the same PR (#42) — and that is exactly
 * the point: nothing *caught* it, someone happened to notice. A denylist of exact
 * names is only ever as current as the last person who remembered to edit it.
 *
 * So keys are matched *structurally* instead: the name is split into words and the
 * **trailing** words decide. `*_secret`, `*_token`, `*_password`, `*_pat`,
 * `*_api_key`, `*_private_key`, `*_webhook_url` … are secret whatever prefix a new
 * integration puts in front of them. Matching the tail (rather than a substring)
 * is what keeps `team_keys`, `api_key_id`, `token_prefix`, `apiKeyLabel` and
 * `public_key` readable — a redaction that hides real data is also a bug.
 *
 * The pattern net is not a proof, so it is backed by `redact-secrets.guard.test.ts`,
 * which sweeps the settings/config sources with a deliberately *wider* net and
 * fails when a secret-shaped key is neither covered here nor explicitly declared
 * safe. New secret keys fail the suite; they do not leak quietly.
 */

const REDACTED = '[redacted]';

/**
 * Split a key into lowercase words across snake_case, kebab-case, camelCase and
 * the `x-api-key` header shape. `webhookSigningSecret` → [webhook, signing, secret].
 */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+|\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Last word is enough: any prefix in front of these makes it no less a secret. */
const SECRET_TAILS = new Set([
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'authorization',
  // GitHub-speak for a token; `github_pat`, `pat`.
  'pat',
  // apps/api/src/connections/connections.service.ts (MN-252) — createConnectionSchema's
  // `auth` is the raw, provider-specific credential payload (e.g. `{ api_key: "..." }`)
  // exactly as the caller submitted it, held in memory before ConnectionsService.create()
  // calls `seal()`. Unlike `auth_kind` (a discriminator string, see DECLARED_SAFE in
  // redact-secrets.guard.test.ts) this is real secret material, so it gets the same
  // wholesale, whole-object redaction as `credential`/`credentials` above — there's no
  // fixed sub-key to pattern-match since every provider's auth shape is different.
  'auth',
]);

/**
 * Two-word tails. `key` and `url` alone are far too common to redact (`team_keys`,
 * `avatar_url`), so the qualifier has to come along: `api_key` yes, `public_key` no.
 */
const SECRET_TAIL_PAIRS = new Set([
  'api key',
  'private key',
  'secret key',
  'signing key',
  'encryption key',
  'access key',
  'session key',
  // A Slack incoming-webhook URL embeds its secret in the path, so it *is* a token.
  'webhook url',
]);

/**
 * Maps whose values are wholesale credential-shaped. An outbound `headers` map is
 * where `Authorization: Bearer …` / `X-Whatever-Token: …` live, and the header
 * *name* is attacker-chosen config — no key pattern can be trusted to catch it. So
 * every value under `headers` is redacted, at the cost of hiding `content-type`
 * too. Header names stay visible, which is what a config UI actually renders.
 */
const OPAQUE_VALUE_CONTAINERS = new Set(['headers', 'header']);

/** True when the key name itself marks the value as a credential. */
export function isSecretKey(key: string): boolean {
  const parts = words(key);
  if (parts.length === 0) return false;
  const last = parts[parts.length - 1]!;
  if (SECRET_TAILS.has(last)) return true;
  if (parts.length >= 2 && SECRET_TAIL_PAIRS.has(`${parts[parts.length - 2]!} ${last}`)) return true;
  // `password2`, `token_1` — a trailing counter shouldn't buy an escape hatch.
  const stripped = last.replace(/\d+$/, '');
  return stripped !== last && SECRET_TAILS.has(stripped);
}

/**
 * `https://user:pass@host/path` carries a credential in a value whose key
 * (`url`, `endpoint`, `target`) looks perfectly innocent — the automation
 * `send_webhook` URL is validated by a schema that explicitly tolerates userinfo.
 * Blank the userinfo and keep the rest: the host is the useful part.
 */
function redactUrlUserinfo(value: string): string {
  return value.replace(
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]+)@/g,
    (_m, scheme: string) => `${scheme}${REDACTED}@`,
  );
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactUrlUserinfo(value);
  return value;
}

/**
 * A boolean is never a secret — it carries one bit. This is what lets the
 * deliberate `has_token` / `has_webhook_secret` presence flags (the write-only
 * pattern every integration config uses) survive a `*_token` tail match.
 */
function isRedactable(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  return typeof value !== 'boolean';
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k) && isRedactable(v)) {
        out[k] = REDACTED;
      } else if (OPAQUE_VALUE_CONTAINERS.has(k.toLowerCase()) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([hk, hv]) => [
            hk,
            isRedactable(hv) ? REDACTED : hv,
          ]),
        );
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out as unknown as T;
  }
  return redactValue(value) as T;
}
