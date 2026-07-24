import multipart from '@fastify/multipart';
import type { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AUTH } from './auth/auth.tokens';
import type { Auth } from './auth/auth';
import { toWebHeaders } from './auth/auth.guard';
import { checkSignInRateLimit, isSignInPath } from './auth/auth-rate-limit';
import { augmentSupportedScopes } from './auth/mcp-scope';
import { env } from './config/env';
import { GITHUB_WEBHOOK_PATH } from './integrations/github-webhook.service';
import { BILLING_WEBHOOK_PATH } from './billing/billing.controller';
import { HOOKS_PATH_PREFIX } from './automations/hooks.controller';
import { RESEND_WEBHOOK_PATH_PREFIX } from './connections/resend-webhook.controller';

/**
 * Routes that need the untouched request bytes, because a signature was
 * computed over *those* bytes and JSON.parse → JSON.stringify does not
 * round-trip (key order, unicode escapes, whitespace, number formatting).
 *
 * Deliberately a tiny allowlist: retaining a second copy of every request body
 * for every route would be a memory and blast-radius mistake, so raw bytes are
 * kept only where an HMAC is actually verified.
 */
const RAW_BODY_PATHS = new Set<string>([GITHUB_WEBHOOK_PATH, BILLING_WEBHOOK_PATH]);

/**
 * `RAW_BODY_PATHS` is exact-match, but MN-254's inbound hook route carries
 * `:workspaceSlug/:hookToken` in the path (and MN-256's Resend webhook
 * carries `:connectionId`) — there's no fixed string to put in the set for
 * either. A prefix check covers both the same way without weakening the
 * exact matches above (nothing else starts with either prefix).
 */
function needsRawBody(path: string): boolean {
  return (
    RAW_BODY_PATHS.has(path) ||
    path.startsWith(HOOKS_PATH_PREFIX) ||
    path.startsWith(RESEND_WEBHOOK_PATH_PREFIX)
  );
}

/** A request whose raw bytes were retained because its path is on the allowlist. */
export type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Shared app configuration — called by main.ts AND the integration-test
 * bootstrap so tests exercise exactly what production runs.
 */
export function configureApp(app: NestFastifyApplication) {
  app.setGlobalPrefix('api/v1', { exclude: ['/', 'healthz', 'api/docs'] });
  registerRawBodyJsonParser(app);
  void app
    .getHttpAdapter()
    .getInstance()
    .register(multipart, { limits: { fileSize: env().ATTACHMENT_MAX_BYTES, files: 1 } });
  app.enableCors({
    origin: [env().WEB_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  mountAuthHandler(app);
}

/**
 * JSON parsing with raw-byte retention for the signature-verifying routes only.
 *
 * Fastify parses `application/json` into an object and drops the bytes, which
 * destroys any HMAC computed over the wire body. We take the parser over so we
 * see the buffer, stash it **only for RAW_BODY_PATHS**, then hand those exact
 * bytes to Fastify's own default parser — parse semantics (proto poisoning,
 * empty-body and syntax errors) stay identical for every route in the app.
 *
 * Nest's `rawBody: true` app option would have been the one-liner, but it keeps
 * a second copy of *every* body on *every* route. One HMAC-verified endpoint is
 * not a reason to double the memory footprint of every upload in the system.
 *
 * The dance with `registerParserMiddleware` is deliberate: Nest registers its
 * own json + urlencoded parsers during `app.init()` and throws if json is
 * already taken. Calling it here first (exactly as init would) registers both
 * and flips Nest's `_isParserRegistered` flag, so init's call no-ops — which
 * lets us swap json alone while urlencoded stays byte-for-byte Nest's.
 */
function registerRawBodyJsonParser(app: NestFastifyApplication) {
  const adapter = app.getHttpAdapter() as FastifyAdapter;
  adapter.registerParserMiddleware('api/v1', false);

  const fastify = adapter.getInstance();
  const { bodyLimit, onProtoPoisoning, onConstructorPoisoning } = fastify.initialConfig;
  const defaultJsonParser = fastify.getDefaultJsonParser(
    onProtoPoisoning ?? 'error',
    onConstructorPoisoning ?? 'error',
  );

  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser<Buffer>(
    'application/json',
    { parseAs: 'buffer', bodyLimit },
    (request, body, done) => {
      // request.url carries the query string; the allowlist is path-only.
      const path = request.url.split('?')[0] ?? '';
      if (needsRawBody(path)) (request as RawBodyRequest).rawBody = body;
      defaultJsonParser(request, body.toString('utf8'), done);
    },
  );

  /**
   * MN-254: the inbound hook receiver also accepts form-encoded submissions
   * (a plain HTML form's default enctype). Nest's own bootstrap already
   * registered a default parser for this content type (see the big comment
   * above — registerParserMiddleware sets up json AND urlencoded), so this
   * takes it over the same way the block above takes over 'application/json':
   * remove Nest's, re-add ours, retaining raw bytes under the same allowlist
   * for the same reason JSON does — an HMAC signs the wire bytes, not a
   * re-serialized body. No other route currently accepts this content type,
   * so behavior for the rest of the app is unchanged.
   */
  fastify.removeContentTypeParser('application/x-www-form-urlencoded');
  fastify.addContentTypeParser<Buffer>(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer', bodyLimit },
    (request, body, done) => {
      const path = request.url.split('?')[0] ?? '';
      if (needsRawBody(path)) (request as RawBodyRequest).rawBody = body;
      const parsed = Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries());
      done(null, parsed);
    },
  );
}

/** Bridges Fastify to better-auth's WHATWG Request/Response handler. */
function mountAuthHandler(app: NestFastifyApplication) {
  const auth = app.get<Auth>(AUTH);
  const throttlerStorage = app.get<ThrottlerStorage>(ThrottlerStorage);
  const fastify = app.getHttpAdapter().getInstance();

  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/v1/auth/*',
    handler: async (request, reply) => {
      // MN-257: better-auth's routes bypass Nest's guard chain (ApiThrottlerGuard
      // included), so sign-in gets its own rate-limit check here — see
      // src/auth/auth-rate-limit.ts for the keying rationale.
      const path = request.url.split('?')[0] ?? '';
      if (isSignInPath(path)) {
        const { allowed, retryAfterSeconds } = await checkSignInRateLimit(
          throttlerStorage,
          request,
        );
        if (!allowed) {
          reply.header('retry-after', String(retryAfterSeconds));
          return reply.status(429).send({
            error: {
              code: 'rate_limited',
              message: 'Too many sign-in attempts. Please try again later.',
              request_id: String(request.id ?? 'unknown'),
            },
          });
        }
      }

      const url = new URL(request.raw.url ?? '/', env().API_URL);
      const body =
        request.body && request.method !== 'GET' ? JSON.stringify(request.body) : undefined;

      // A WHATWG Request is single-use: better-auth's internal transaction
      // wrapper may re-read it, so build a fresh Request (fresh Headers, fresh
      // body) per attempt. content-length is stripped — we re-serialize the
      // body, so the original length may be stale; undici recomputes it.
      const makeRequest = (): Request => {
        const headers = toWebHeaders(request.headers);
        headers.delete('content-length');
        headers.delete('transfer-encoding');
        if (body) headers.set('content-type', 'application/json');
        const webRequest = new Request(url, { method: request.method, headers, body });
        // better-auth calls request.clone() AFTER consuming the body (e.g.
        // sign-up.mjs passes ctx.request.clone() to sendVerificationEmail),
        // which throws TypeError "unusable" per the fetch spec. We own the
        // full body string, so a "clone" can simply be a fresh Request.
        webRequest.clone = makeRequest;
        return webRequest;
      };

      let response: Response;
      try {
        response = await auth.handler(makeRequest());
      } catch (firstError) {
        if (firstError instanceof TypeError) {
          // "unusable" (consumed body) — retry once with a brand-new Request.
          request.log.warn({ err: firstError }, 'auth handler TypeError, retrying once');
          try {
            response = await auth.handler(makeRequest());
          } catch (retryError) {
            return sendAuthError(request.id, reply, retryError, request.log);
          }
        } else {
          return sendAuthError(request.id, reply, firstError, request.log);
        }
      }
      // #331: the guard requires `storyos.mcp` on OAuth tokens, but better-auth's
      // mcp plugin hardcodes `scopes_supported` in its authorization-server
      // discovery document and ignores `oidcConfig.metadata.scopes_supported`, so
      // the scope is never advertised, never requested by a client, never granted —
      // and every tool call then 401s. Rewriting the discovery response here is the
      // only place the plugin leaves us to advertise it (see mcp-scope.ts).
      if (env().MCP_OAUTH && isAsMetadataPath(path)) {
        response = await augmentAsMetadataResponse(response);
      }
      return sendAuthResponse(reply, response);
    },
  });
}

/** The authorization-server metadata document (RFC 8414), mounted under the auth base. */
function isAsMetadataPath(path: string): boolean {
  return path === '/api/v1/auth/.well-known/oauth-authorization-server';
}

/**
 * Re-serialize the AS-metadata response with `storyos.mcp` (and the full
 * supported set) merged into `scopes_supported`. Content-length is dropped so
 * Fastify recomputes it from the new — longer — body (see sendAuthResponse).
 * On any parse hiccup the original response is returned untouched: advertising
 * the extra scope is a nicety, never worth breaking discovery over.
 */
async function augmentAsMetadataResponse(response: Response): Promise<Response> {
  try {
    const doc = (await response.clone().json()) as Record<string, unknown>;
    const augmented = augmentSupportedScopes(doc);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(augmented), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

async function sendAuthResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  const text = await response.text();
  await reply.send(text.length > 0 ? text : null);
}

async function sendAuthError(
  requestId: unknown,
  reply: FastifyReply,
  error: unknown,
  log: { error: (obj: unknown, msg: string) => void },
) {
  log.error({ err: error }, 'better-auth handler threw');
  if (process.env.NODE_ENV === 'test') console.error('AUTH HANDLER ERROR:', error);
  await reply.status(500).send({
    error: {
      code: 'internal_error',
      message: 'Authentication service error',
      request_id: String(requestId ?? 'unknown'),
    },
  });
}
