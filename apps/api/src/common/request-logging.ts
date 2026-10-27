/**
 * #1078 — what a request log line may say about the URL.
 *
 * The request URL carries credentials on several routes: the password-reset
 * token (`/auth/reset-password/<token>`), the email-verification JWT
 * (`/auth/verify-email?token=`), a signed download's `sig`, an OAuth `code`,
 * and the public share/form/skill token that IS the access check for
 * `/public/(views|forms|skills)/<token>`. pino-http wrote `req.url` (and the
 * parsed `query`) verbatim at info level, so every one of those landed in the
 * log — the same leak the header redaction below closed for `authorization` and
 * `cookie`.
 *
 * Query VALUES are dropped wholesale, names are kept: a list of secret
 * parameter names would be one more denylist that is only as current as the
 * last person who remembered it (see redact-secrets.ts), while the names alone
 * still answer "which call was this?".
 */
const REDACTED = '[redacted]';

/** Path segments that are themselves a credential: the segment right after each prefix. */
const TOKEN_SEGMENT = /(\/(?:public\/(?:views|forms|skills)|auth\/reset-password)\/)[^/?#]+/g;

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  const path = (q === -1 ? url : url.slice(0, q)).replace(TOKEN_SEGMENT, `$1${REDACTED}`);
  if (q === -1) return path;
  const names = url
    .slice(q + 1)
    .split('&')
    .filter((pair) => pair.length > 0)
    .map((pair) => `${pair.split('=')[0]}=${REDACTED}`);
  return names.length > 0 ? `${path}?${names.join('&')}` : path;
}

interface SerializedReq {
  url?: string;
  query?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

function redactValues(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.keys(obj).map((k) => [k, REDACTED]));
}

/** pino-http `serializers.req`: receives pino's standard serialized request. */
export function redactRequestSerializer(req: SerializedReq): SerializedReq {
  if (typeof req.url === 'string') req.url = redactUrl(req.url);
  if (req.query) req.query = redactValues(req.query);
  if (req.params && typeof req.params === 'object' && 'token' in req.params) {
    req.params = { ...(req.params as object), token: REDACTED };
  }
  return req;
}

/** The pino-http options app.module.ts spreads into LoggerModule — exported so a test drives the real config. */
export const requestLogRedaction = {
  /**
   * pino's default `req` serializer logs `headers` verbatim, so every single
   * request was writing its `authorization: Bearer mn_pat_…` and its session
   * cookie into the log at info level. A secret in a log file is the same
   * leak as a secret in a response — logs get shipped, tailed and retained
   * far more casually than an API payload.
   *
   * `censor` (not `remove`) so "was a token even sent?" stays answerable
   * while debugging auth.
   */
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-hub-signature-256"]',
      'res.headers["set-cookie"]',
    ],
    censor: REDACTED,
  },
  serializers: { req: redactRequestSerializer },
};
