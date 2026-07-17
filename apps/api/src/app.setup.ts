import multipart from '@fastify/multipart';
import type { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AUTH } from './auth/auth.tokens';
import type { Auth } from './auth/auth';
import { toWebHeaders } from './auth/auth.guard';
import { env } from './config/env';
import { GITHUB_WEBHOOK_PATH } from './integrations/github-webhook.service';

/**
 * Routes that need the untouched request bytes, because a signature was
 * computed over *those* bytes and JSON.parse → JSON.stringify does not
 * round-trip (key order, unicode escapes, whitespace, number formatting).
 *
 * Deliberately a tiny allowlist: retaining a second copy of every request body
 * for every route would be a memory and blast-radius mistake, so raw bytes are
 * kept only where an HMAC is actually verified.
 */
const RAW_BODY_PATHS = new Set<string>([GITHUB_WEBHOOK_PATH]);

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
      if (RAW_BODY_PATHS.has(path)) (request as RawBodyRequest).rawBody = body;
      defaultJsonParser(request, body.toString('utf8'), done);
    },
  );
}

/** Bridges Fastify to better-auth's WHATWG Request/Response handler. */
function mountAuthHandler(app: NestFastifyApplication) {
  const auth = app.get<Auth>(AUTH);
  const fastify = app.getHttpAdapter().getInstance();

  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/v1/auth/*',
    handler: async (request, reply) => {
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
      return sendAuthResponse(reply, response);
    },
  });
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
