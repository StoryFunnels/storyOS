import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { AUTH } from './auth/auth.tokens';
import type { Auth } from './auth/auth';
import { toWebHeaders } from './auth/auth.guard';
import { env } from './config/env';

/**
 * Shared app configuration — called by main.ts AND the integration-test
 * bootstrap so tests exercise exactly what production runs.
 */
export function configureApp(app: NestFastifyApplication) {
  app.setGlobalPrefix('api/v1', { exclude: ['/', 'healthz', 'api/docs'] });
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
