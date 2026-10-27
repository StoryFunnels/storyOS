/**
 * Write-only outbound-webhook headers (#249, #1068).
 *
 * A `send_webhook` / `http_request` action (button field config AND automation
 * actions) may carry credentials in its `headers` map — `Authorization: Bearer …`,
 * a session `Cookie`, an `X-Api-Key` — or in its URL's userinfo
 * (`https://user:pass@host`). Both carriers are read back at low privilege: button
 * field config rides the database introspection payload (any viewer, guests
 * included) and automation actions ride the rules list. Serving those values
 * verbatim is a straight credential leak.
 *
 * `redact-secrets` already blanks these values to `[redacted]` on the export/pack
 * path, but a plain redaction can't survive a round-trip: the config editors load
 * the whole actions array and write it back wholesale, so a `[redacted]` string
 * would be saved straight over the real credential on the next unrelated edit —
 * turning a read leak into data loss. So these two carriers use a presence flag
 * instead:
 *
 *   read   any header value      →  { __keep: true }   (the value never leaves)
 *          URL userinfo           →  `***@`
 *   write  { __keep: true } / `***@` →  the stored value is preserved — but only
 *          from a stored action with the same URL destination (scheme + host +
 *          port) and, for a header, the same header name
 *          "a real new string"   →  replaces the stored value
 *          (header omitted)       →  the header is dropped
 *
 * #1068: EVERY header value is write-only, not just the ones whose name looks like a
 * credential — a name-based rule missed `X-Custom-Auth`-style headers. And a kept
 * secret is bound to its destination: before, a flag was resolved against the
 * stored action at the same array index whatever its URL, so an editor could point
 * the action at their own host and echo `{ __keep: true }` to receive the secret.
 */
import { UnprocessableEntityException } from '@nestjs/common';

/**
 * The presence sentinel. Returned in place of a header value on read, and
 * accepted on write to mean "keep the stored credential unchanged". An object (not
 * a string) on purpose: a user can never type it into a header-value text box, so
 * there is no "user legitimately typed the sentinel" ambiguity a string marker has.
 */
export const HEADER_KEEP_FLAG = { __keep: true } as const;

/** #1068 — what a URL's userinfo reads back as; echoing it keeps the stored userinfo. */
export const URL_USERINFO_MASK = '***';

export function isHeaderKeepFlag(value: unknown): value is { __keep: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __keep?: unknown }).__keep === true
  );
}

// `scheme:` + optional slashes + userinfo + `@`. Hand-matched rather than via URL so a
// {Field} template survives the round-trip unchanged. Loose on purpose (no `//`
// required, `\` excluded from the authority) to cover what the WHATWG parser — the
// one the sender uses — also reads as userinfo, e.g. `https:user:pass@host`.
// eslint-disable-next-line no-control-regex -- the URL parser strips leading C0 controls; so must we
const USERINFO_RE = /^([\x00-\x20]*[a-z][a-z0-9+.-]*:[\\/]*)([^/?#\\]*)@/i;
// The URL parser drops tab/newline anywhere, so must the matcher.
const stripTabs = (url: string) => url.replace(/[\t\n\r]/g, '');

function userinfoOf(url: string): string | undefined {
  return USERINFO_RE.exec(stripTabs(url))?.[2];
}

function withUserinfo(url: string, userinfo: string | undefined): string {
  const clean = stripTabs(url);
  if (!USERINFO_RE.test(clean)) return url;
  return clean.replace(USERINFO_RE, (_m, scheme: string) => (userinfo ? `${scheme}${userinfo}@` : scheme));
}

/** Read-side: a URL with its userinfo (`user:pass@`) replaced by the mask. */
export function maskUrlUserinfo(url: string): string {
  return userinfoOf(url) === undefined ? url : withUserinfo(url, URL_USERINFO_MASK);
}

/** #1068 — mask every `scheme://user:pass@` inside free text (an approval's preview line). */
export function maskUserinfoInText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#\\]*@/gi, `$1${URL_USERINFO_MASK}@`);
}

/** Where a request goes: scheme + host + port. A URL the parser can't read (a fully
 * templated `{payload.url}`) only matches the identical string. */
function destinationOf(url: string): string {
  const bare = withUserinfo(url, undefined).trim();
  try {
    const parsed = new URL(bare);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return `raw:${bare}`;
  }
}

type UnknownAction = Record<string, unknown>;

function isUrlAction(action: UnknownAction): boolean {
  return action.type === 'send_webhook' || action.type === 'http_request';
}

/** MN-263: http_request carries the same shape of caller-supplied `headers` map
 * (an Authorization/X-Api-Key value typed by hand, not via a connection) — same
 * write-only treatment as send_webhook's. */
function webhookHeaders(action: UnknownAction): Record<string, unknown> | undefined {
  if (!isUrlAction(action)) return undefined;
  const headers = action.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  return headers as Record<string, unknown>;
}

/**
 * Read-side: replace every header VALUE with the presence flag and mask the URL's
 * userinfo. Neither a header value nor URL credentials are ever returned.
 */
export function presentActionHeaders<T>(actions: T): T {
  if (!Array.isArray(actions)) return actions;
  return actions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const action = entry as UnknownAction;
    if (!isUrlAction(action)) return action;
    const out: UnknownAction = { ...action };
    if (typeof action.url === 'string') out.url = maskUrlUserinfo(action.url);
    const headers = webhookHeaders(action);
    if (headers) {
      out.headers = Object.fromEntries(Object.keys(headers).map((name) => [name, { ...HEADER_KEEP_FLAG }]));
    }
    return out;
  }) as unknown as T;
}

/**
 * The stored action a keep request may draw from: one whose URL goes to the same
 * destination (#1068) — never just "whatever sat at this index". The same index /
 * the identical URL wins among several, so reordering actions keeps each secret
 * with its own action.
 */
function matchStoredAction(
  url: string,
  stored: UnknownAction[],
  index: number,
): UnknownAction | undefined {
  const dest = destinationOf(url);
  const bare = withUserinfo(url, undefined);
  const candidates = stored.filter(
    (s) => s && isUrlAction(s) && typeof s.url === 'string' && destinationOf(s.url) === dest,
  );
  const sameUrl = (s: UnknownAction) => withUserinfo(s.url as string, undefined) === bare;
  const atIndex = candidates.find((s) => s === stored[index]);
  if (atIndex && sameUrl(atIndex)) return atIndex;
  return candidates.find(sameUrl) ?? atIndex ?? candidates[0];
}

/**
 * Write-side: resolve presence flags against the previously stored actions so an
 * unchanged secret keeps its value, a real new string replaces it, and nothing is
 * ever fabricated or leaked. The returned actions carry only string header values
 * and real URLs — safe to persist.
 *
 * A flag that has nothing to resolve against — the URL now goes to another host,
 * or the header was renamed — is a 422 on an update (the editor must re-enter the
 * value; dropping it silently would lose e.g. a Content-Type the UI still shows).
 * On a create (`stored` empty: nothing could be kept anyway) the flag is dropped.
 */
export function restoreActionHeaders<T>(incoming: T, stored: unknown): T {
  if (!Array.isArray(incoming)) return incoming;
  const storedActions = (Array.isArray(stored) ? stored : []) as UnknownAction[];
  const isUpdate = storedActions.length > 0;
  return incoming.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const action = entry as UnknownAction;
    if (!isUrlAction(action)) return action;
    const url = typeof action.url === 'string' ? action.url : '';
    const headers = webhookHeaders(action);
    const keepsUserinfo = userinfoOf(url) === URL_USERINFO_MASK;
    const keptNames = Object.entries(headers ?? {})
      .filter(([, value]) => isHeaderKeepFlag(value))
      .map(([name]) => name);
    const prev = keepsUserinfo || keptNames.length > 0 ? matchStoredAction(url, storedActions, index) : undefined;
    const prevHeaders = prev ? webhookHeaders(prev) : undefined;
    const missing: string[] = [];

    const out: UnknownAction = { ...action };
    if (keepsUserinfo) {
      const prevUserinfo = prev ? userinfoOf(prev.url as string) : undefined;
      if (!prev) missing.push('the URL credentials');
      out.url = withUserinfo(url, prevUserinfo);
    }
    if (headers) {
      const restored: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (isHeaderKeepFlag(value)) {
          const stashed = prevHeaders?.[name];
          if (typeof stashed === 'string') restored[name] = stashed;
          else missing.push(`header "${name}"`);
        } else if (typeof value === 'string') {
          restored[name] = value;
        }
      }
      out.headers = restored;
    }
    if (isUpdate && missing.length > 0) {
      throw new UnprocessableEntityException(
        `Action ${index + 1} (${String(action.type)}): re-enter ${missing.join(', ')} — a saved secret is only ` +
          'kept while the URL host and the header name stay the same.',
      );
    }
    return out;
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
