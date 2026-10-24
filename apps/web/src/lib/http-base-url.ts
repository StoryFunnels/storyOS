/**
 * #1035 — an HTTP connection's credential is sent ONLY to its base URL: scheme, host, port and a path prefix. A member who
 * writes a rule chooses the request URL, so without a base URL they could point a shared admin connection at their own
 * server and receive the token. The API refuses a request outside the base (and a connection with none sends nothing).
 *
 * `httpBaseUrlProblem` mirrors the API's rule (`providers/http.ts`) so the admin hears about a bad value before saving;
 * the SERVER stays the authority and its message is shown if it disagrees.
 */
export function httpBaseUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Enter the one address this credential may be sent to, for example https://api.example.com/v1.';
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'That is not a valid address. Start with https:// and include the host.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The address must start with https:// (or http://).';
  if (u.username || u.password) return 'Leave the username and password out of the address; they belong in the credential.';
  if (u.search || u.hash) return 'Leave out anything after ? or #: the base URL is just the host and a path prefix.';
  return null;
}

/** What the connection row says about where its credential goes. */
export function baseUrlSummary(c: { provider: string; base_url?: string | null; needs_base_url?: boolean }): string | null {
  if (c.provider !== 'http') return null;
  if (c.needs_base_url || !c.base_url) return null;
  return `Sends its credential only to ${c.base_url}`;
}

/** Does this connection carry the "Needs base URL" badge? Only HTTP connections the API flags. */
export const needsBaseUrl = (c: { provider: string; needs_base_url?: boolean }): boolean =>
  c.provider === 'http' && c.needs_base_url === true;
