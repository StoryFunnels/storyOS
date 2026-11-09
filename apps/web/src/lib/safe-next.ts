/**
 * Ticket #1052 — where `?next=` may send someone after sign-in or sign-up: a path on THIS site, nothing else. `//evil.com`
 * and `/\evil.com` are other sites to a browser, and a full URL is too. Anything that is not a plain same-origin path
 * falls back to `/`.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  // Control characters and backslashes are stripped or mis-read by browsers, so anything carrying them is refused.
  if (next.includes('\\') || [...next].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return '/';
  try {
    const base = 'https://storyos.invalid';
    const url = new URL(next, base);
    if (url.origin !== base) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
