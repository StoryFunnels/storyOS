import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cspForRequest, generateNonce } from '@/lib/security-headers.mjs';

/**
 * Ticket #1238: the Content-Security-Policy, ENFORCED, with a fresh nonce per request. Next reads the nonce back out of the
 * request's own CSP header while it renders and stamps it on its framework scripts, `next/script` and inline styles, so the
 * policy can drop `'unsafe-inline'` for scripts. The policy itself is built in `lib/security-headers.mjs` (unit-tested).
 *
 * Two kinds of input (ticket #1343 corrected this comment, which said everything is read per request):
 *  - BUILD-time: `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_POSTHOG_HOST`. Next inlines `NEXT_PUBLIC_*` into this bundle as it does into
 *    the client's, so these are the values the client was built with. Set them when the image is built: the client can only call the
 *    origin it was built with, so a value given only to the running container is not supported (policy and client would disagree).
 *  - REQUEST-time, read from the container's env on every request: `WEB_URL` (decides whether `upgrade-insecure-requests` is
 *    safe) and `CSP_MODE=report-only` (switches enforcement off without a rebuild).
 */
export function proxy(request: NextRequest) {
  const { name, value, nonce } = cspForRequest(
    {
      // Same fallback as src/lib/api.ts: unset means dev's localhost:3001 API; the Docker build passes '' (same-origin).
      apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
      posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      webUrl: process.env.WEB_URL,
      mode: process.env.CSP_MODE,
      dev: process.env.NODE_ENV === 'development',
    },
    { pathname: request.nextUrl.pathname, nonce: generateNonce() },
  );

  const requestHeaders = new Headers(request.headers);
  // Only the header we set may carry a nonce into the render: drop a client-supplied twin of the other name.
  requestHeaders.delete('Content-Security-Policy');
  requestHeaders.delete('Content-Security-Policy-Report-Only');
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set(name, value);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the build's static files (hashed, immutable), the `/ingest` analytics rewrite (a proxy to a third
      // party), or the report sink itself. Prefetches are skipped as the Next guide recommends; the real navigation gets a
      // nonce'd document.
      source: '/((?!_next/static|_next/image|ingest|csp-report|favicon).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
