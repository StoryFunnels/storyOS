import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { OpenAPIObject } from '@nestjs/swagger';
import { MIN_ROLE_KEY } from './workspaces/workspace-access.guard';

/** Builds the OpenAPI document — single source shared by runtime serving and the generate script. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('StoryOS API')
    .setDescription(
      'The public StoryOS REST API. The web app is client #1 of this same API — everything the UI does, you can do.',
    )
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  annotateMinRole(app, document);
  return document;
}

const HTTP_METHODS: Record<number, string> = { 0: 'get', 1: 'post', 2: 'put', 3: 'delete', 4: 'patch' };

/**
 * #1081 — say, in the spec itself, which WORKSPACE ROLE a route needs (`x-min-role`: `member` | `admin`; absent = any member,
 * guests included). The MCP uses it to list only the tools the person's role can use, so the fact is derived from the very
 * decorator that enforces it (`@MinRole`, handler over controller exactly as the guard resolves it) instead of a second list that
 * would drift. Advertising only: the guard still refuses the call.
 */
function annotateMinRole(app: INestApplication, document: OpenAPIObject): void {
  for (const mod of app.get(ModulesContainer).values()) {
    for (const controller of mod.controllers.values()) {
      const cls = controller.metatype as (new (...args: never[]) => unknown) | null;
      if (!cls) continue;
      const base: string = Reflect.getMetadata('path', cls) ?? '/';
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[name as keyof typeof cls.prototype] as unknown;
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const verb = HTTP_METHODS[Reflect.getMetadata('method', handler) as number];
        if (!verb) continue;
        const role = (Reflect.getMetadata(MIN_ROLE_KEY, handler) ?? Reflect.getMetadata(MIN_ROLE_KEY, cls)) as string | undefined;
        if (role !== 'member' && role !== 'admin') continue;
        const sub: string = Reflect.getMetadata('path', handler) ?? '/';
        const path = `/api/v1/${base}/${sub}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1').replace(/:([A-Za-z_]+)/g, '{$1}');
        const operation = (document.paths[path] as Record<string, Record<string, unknown>> | undefined)?.[verb];
        if (operation) operation['x-min-role'] = role;
      }
    }
  }
}
