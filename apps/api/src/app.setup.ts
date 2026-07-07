import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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
      const headers = toWebHeaders(request.headers);

      const init: RequestInit = { method: request.method, headers };
      if (request.body && request.method !== 'GET') {
        init.body = JSON.stringify(request.body);
        headers.set('content-type', 'application/json');
      }

      const response = await auth.handler(new Request(url, init));

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);

      const body = await response.text();
      await reply.send(body.length > 0 ? body : null);
    },
  });
}
