/**
 * Ticket #921 — a failed API call must never put the response body on screen unless the body is
 * StoryOS's own JSON error envelope.
 *
 * When the API is down or restarting, the thing that answers is not StoryOS: it is the proxy in front
 * of it (Cloudflare returns a full "502: Bad gateway" HTML document). The SDK client hands a non-JSON
 * body back as the error itself, so `This view couldn't load` printed the whole document as text.
 * The fix is at the one place every call passes through (`api.ts` wraps the client's fetch with
 * `withSafeErrors`), so every surface that reads `error` gets a short message and none has to
 * remember to filter markup.
 */

/** 502/503/504: the server is not there to answer, the case the user can only wait out. */
export function isUpstreamUnavailable(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export const UPSTREAM_UNAVAILABLE_MESSAGE = 'StoryOS is restarting or unreachable. Try again in a minute.';

/** A short, fixed sentence by status class. Never derived from the response body. */
export function fallbackMessageForStatus(status: number): string {
  if (isUpstreamUnavailable(status)) return UPSTREAM_UNAVAILABLE_MESSAGE;
  return `The server sent an unexpected response (${status}). Try again, and tell us if it keeps happening.`;
}

function isJsonResponse(res: Response): boolean {
  return /\bjson\b/i.test(res.headers.get('content-type') ?? '');
}

/**
 * Wrap a fetch so a 4xx/5xx that is NOT JSON comes back as StoryOS's own error envelope, with a fixed
 * message. A JSON error (StoryOS's envelope) and any success pass through untouched, so every API
 * message the user sees today they still see.
 */
export function withSafeErrors(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (res.status < 400 || isJsonResponse(res)) return res;
    // The body is the proxy's page, not ours: drop it unread.
    void res.body?.cancel().catch(() => undefined);
    return new Response(
      JSON.stringify({
        error: {
          code: isUpstreamUnavailable(res.status) ? 'upstream_unavailable' : 'unexpected_response',
          message: fallbackMessageForStatus(res.status),
          meta: { status: res.status },
        },
      }),
      { status: res.status, statusText: res.statusText, headers: { 'content-type': 'application/json' } },
    );
  };
}

/** True for text that is a document or tag soup rather than a sentence. */
export function looksLikeMarkup(text: string): boolean {
  return /<\s*(!doctype|html|head|body|div|span|script|style|center|h[1-6]|p|title)\b/i.test(text);
}
