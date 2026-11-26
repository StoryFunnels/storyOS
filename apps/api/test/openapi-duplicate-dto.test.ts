import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { buildOpenApiDocument } from '../src/openapi.setup';

/**
 * #1341 — two controllers declared a body class with the same name, so the OpenAPI generator warned "Duplicate DTO detected" at boot,
 * and, worse, kept only ONE of the two schemas: the other endpoint was documented (and its SDK type generated) with the wrong body.
 * The generator's own warning is the detector: it is how the library reports "two different schemas, one name", and it says it will
 * become an error in the next major version. The test builds the same document the API serves and fails on any such warning, so the
 * next accidental name collision is caught here and not by someone reading a boot log.
 */
let app: NestFastifyApplication;
let warnings: string[] = [];
let doc: ReturnType<typeof buildOpenApiDocument>;

beforeAll(async () => {
  app = await createTestApp();
  const spy = vi.spyOn(Logger, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  warnings = [];
  doc = buildOpenApiDocument(app);
  spy.mockRestore();
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1341 the OpenAPI document has no duplicate DTO names', () => {
  it('building the document logs no "Duplicate DTO" warning', () => {
    expect(warnings.filter((w) => w.includes('Duplicate DTO'))).toEqual([]);
  });

  it('each build endpoint documents its OWN body: the Architect takes a plan, a Tyron thread takes a description', () => {
    const bodyOf = (path: string): Record<string, unknown> => {
      const op = (doc.paths[path] as Record<string, { requestBody?: { content: Record<string, { schema: { $ref?: string } }> } }>).post;
      const ref = op?.requestBody?.content['application/json']?.schema.$ref ?? '';
      return (doc.components?.schemas?.[ref.split('/').pop() ?? ''] ?? {}) as Record<string, unknown>;
    };
    const architect = bodyOf('/api/v1/workspaces/{ws}/architect/build');
    const tyron = bodyOf('/api/v1/workspaces/{ws}/tyron/threads/{thread}/build');
    expect(Object.keys(architect.properties as object)).toEqual(['plan']);
    expect(Object.keys(tyron.properties as object)).toEqual(['description']);
  });
});
