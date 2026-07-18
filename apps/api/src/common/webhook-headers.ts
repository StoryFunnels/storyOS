/**
 * Write-only outbound-webhook headers (#249).
 *
 * A `send_webhook` action (button field config AND automation actions) may carry
 * credentials in its `headers` map — `Authorization: Bearer …`, a session `Cookie`,
 * an `X-Api-Key`. Both carriers are read back at low privilege: button field config
 * rides the database introspection payload (any viewer, guests included) and
 * automation actions ride the rules list. Serving those header values verbatim is a
 * straight credential leak.
 *
 * `redact-secrets` already blanks these values to `[redacted]` on the export/pack
 * path, but a plain redaction can't survive a round-trip: the config editors load
 * the whole actions array and write it back wholesale, so a `[redacted]` string
 * would be saved straight over the real credential on the next unrelated edit —
 * turning a read leak into data loss. So these two carriers use a presence flag
 * instead:
 *
 *   read   secret header value  →  { __keep: true }   (the value never leaves)
 *   write  { __keep: true }      →  the stored value is preserved
 *          "a real new string"   →  replaces the stored value
 *          (header omitted)       →  the header is dropped
 *
 * Which header NAMES count as secret reuses the redact-secrets key classifier
 * (`authorization`, `*-token`, `*-api-key`, …) plus the header-only names it can't
 * infer from a key shape (`cookie`, `set-cookie`, `proxy-authorization`). One rule,
 * not two.
 */
import { isSecretKey } from './redact-secrets';

/**
 * The presence sentinel. Returned in place of a secret header value on read, and
 * accepted on write to mean "keep the stored credential unchanged". An object (not
 * a string) on purpose: a user can never type it into a header-value text box, so
 * there is no "user legitimately typed the sentinel" ambiguity a string marker has.
 */
export const HEADER_KEEP_FLAG = { __keep: true } as const;

export function isHeaderKeepFlag(value: unknown): value is { __keep: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __keep?: unknown }).__keep === true
  );
}

/** Header names whose VALUE is a credential — the redact-secrets rule + header-only names. */
export function isSecretHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'cookie' || lower === 'set-cookie' || lower === 'proxy-authorization') {
    return true;
  }
  return isSecretKey(name);
}

type UnknownAction = Record<string, unknown>;

function webhookHeaders(action: UnknownAction): Record<string, unknown> | undefined {
  if (action.type !== 'send_webhook') return undefined;
  const headers = action.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  return headers as Record<string, unknown>;
}

/**
 * Read-side: replace every secret header VALUE with the presence flag. Non-secret
 * headers (`content-type`, …) pass through. A secret header value is never returned.
 */
export function presentActionHeaders<T>(actions: T): T {
  if (!Array.isArray(actions)) return actions;
  return actions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const action = entry as UnknownAction;
    const headers = webhookHeaders(action);
    if (!headers) return action;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers)) {
      out[name] = isSecretHeaderName(name) ? { ...HEADER_KEEP_FLAG } : value;
    }
    return { ...action, headers: out };
  }) as unknown as T;
}

function matchStoredHeaders(
  action: UnknownAction,
  stored: UnknownAction[],
  index: number,
): Record<string, unknown> | undefined {
  // The editors round-trip the actions array in order, so same-index is the
  // common case; fall back to the same webhook URL if a sibling action shifted it.
  const atIndex = stored[index];
  const fromIndex = atIndex ? webhookHeaders(atIndex) : undefined;
  if (fromIndex) return fromIndex;
  const byUrl = stored.find((s) => s?.type === 'send_webhook' && s.url === action.url);
  return byUrl ? webhookHeaders(byUrl) : undefined;
}

/**
 * Write-side: resolve presence flags against the previously stored actions so an
 * unchanged secret header keeps its value, a real new string replaces it, and a
 * flag with no stored counterpart is dropped (never fabricated, never leaked).
 * The returned actions carry only string header values — safe to persist.
 */
export function restoreActionHeaders<T>(incoming: T, stored: unknown): T {
  if (!Array.isArray(incoming)) return incoming;
  const storedActions = (Array.isArray(stored) ? stored : []) as UnknownAction[];
  return incoming.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const action = entry as UnknownAction;
    const headers = webhookHeaders(action);
    if (!headers) return action;
    const prev = matchStoredHeaders(action, storedActions, index);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (isHeaderKeepFlag(value)) {
        const stashed = prev?.[name];
        if (typeof stashed === 'string') out[name] = stashed;
      } else if (typeof value === 'string') {
        out[name] = value;
      }
    }
    return { ...action, headers: out };
  }) as unknown as T;
}

/** Present a field's config for read — hides secret header values in a button's actions. */
export function presentFieldConfig<T>(config: T): T {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const cfg = config as Record<string, unknown>;
  if (!Array.isArray(cfg.actions)) return config;
  return { ...cfg, actions: presentActionHeaders(cfg.actions) } as T;
}

/** Restore a field's config on write — resolves presence flags in a button's actions. */
export function restoreFieldConfig<T>(incoming: T, stored: unknown): T {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const cfg = incoming as Record<string, unknown>;
  if (!Array.isArray(cfg.actions)) return incoming;
  const storedActions =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>).actions
      : undefined;
  return { ...cfg, actions: restoreActionHeaders(cfg.actions, storedActions) } as T;
}

/** Persisted actions only ever hold string header values; coerce for the sender's type. */
export function stringHeadersOnly(
  headers: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
