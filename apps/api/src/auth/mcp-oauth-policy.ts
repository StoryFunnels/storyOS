/**
 * #1030 — who may register as an OAuth client of the hosted-MCP authorization server, and what a grant looks like.
 *
 * Dynamic client registration (RFC 7591) is open by design: no session, any client. That was safe only while the
 * authorize step asked the person first; it did not (a logged-in victim following one link handed their whole account to
 * whoever registered the client). Consent is now always required (app.setup forces it), and registration is narrowed on
 * top: a redirect URI must be one a real AI client uses, so a client for `https://evil.example/cb` cannot even be created.
 */

/** Hosts the well-known hosted AI clients redirect to over https (their connector callback pages). */
export const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com', 'chat.openai.com', 'platform.openai.com'] as const;

/** Native clients (Claude Code, Codex, Gemini CLI and the like) listen on a loopback port; http is the norm there (RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Schemes that run code or read the machine rather than hand a code to an app: never a redirect target. */
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'ftp', 'ws', 'wss']);

/** Parse the operator's extension list: extra https hosts (`host`, comma-separated). */
export function parseRedirectAllowlist(raw: string | undefined): { hosts: string[] } {
  return { hosts: (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) };
}

/**
 * Whether a redirect URI may be REGISTERED. (At authorize time better-auth then requires the request's `redirect_uri` to be
 * byte-for-byte one of the registered ones: no prefix, no wildcard.)
 *  - https: only the built-in AI hosts and the operator's additions;
 *  - http: loopback only (RFC 8252 §7.3), any port;
 *  - a custom scheme (cursor://, vscode://, ...): a native app's own scheme, allowed; the dangerous ones (javascript:, data:,
 *    vbscript:, file:, blob:, ...) never.
 */
export function redirectUriAllowed(uri: string, extra: { hosts: string[] }): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false; // credentials or a fragment in a redirect URI is never legitimate
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const host = u.hostname.startsWith('[') ? u.hostname : u.hostname.toLowerCase();
  if (scheme === 'https') return new Set<string>([...DEFAULT_REDIRECT_HOSTS, ...extra.hosts]).has(host);
  if (scheme === 'http') return LOOPBACK_HOSTS.has(host); // http is only ever for the machine's own loopback
  return !BLOCKED_SCHEMES.has(scheme);
}

/** The first redirect URI in a registration body that is not allowed, or null. The body is untrusted: anything that is not a list of strings fails. */
export function firstDisallowedRedirect(body: unknown, extra: { hosts: string[] }): string | null {
  const uris = (body as { redirect_uris?: unknown } | null | undefined)?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return '(none)';
  for (const uri of uris) {
    if (typeof uri !== 'string' || !redirectUriAllowed(uri, extra)) return typeof uri === 'string' ? uri : '(not a string)';
  }
  return null;
}
