/**
 * Ticket #1032 — a URL the product will NAVIGATE to must be http(s). `javascript:`, `data:` and `vbscript:` all parse as valid URLs
 * (zod's `.url()` accepts them), and `window.location.href = "javascript:…"` runs the script on the app's own origin, with the
 * visitor's session: a public form's redirect_url was a stored XSS and a cross-tenant account takeover.
 *
 * The check is made on the PARSED protocol, not on the text, because the URL parser is what the browser will use: it strips a
 * leading control character or space and any tab or newline inside the scheme, so `java\tscript:`, ` javascript:` and `JaVaScRiPt:`
 * are all `javascript:` to the browser and must be to this check too.
 *
 * Zod-free on purpose (like state-category): the MCP bundle imports it by subpath, and the web page, the API and the schema all call
 * the SAME function so the rule cannot drift between them.
 */
/** This package's tsconfig has no DOM or Node lib, but `URL` exists everywhere the file runs (browsers, Node, the MCP bundle). */
declare const URL: new (input: string) => { protocol: string };

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The value if it is an http(s) URL, else null: for reading something already stored, which must never be trusted to still be safe. */
export function safeHttpUrl(value: unknown): string | null {
  return isHttpUrl(value) ? value : null;
}

export const HTTP_URL_MESSAGE = 'must be an http:// or https:// address';
