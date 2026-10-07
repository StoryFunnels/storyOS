/**
 * Writes docs/api/openapi.json from the live route definitions.
 * Run via `pnpm --filter @storyos/api openapi:generate`. CI fails on drift.
 */
// #658: MUST be the first import — see main.ts's own comment. Without this,
// apps/api/.env is never read and DATABASE_URL silently falls back to the
// shared founder dev database.
import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { buildOpenApiDocument } from './openapi.setup';

async function generate() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 3 * 1024 * 1024 }), {
    logger: false,
  });
  configureApp(app);

  const document = buildOpenApiDocument(app);
  const outPath = join(__dirname, '..', '..', '..', 'docs', 'api', 'openapi.json');
  writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n');
   
  console.log(`OpenAPI spec written to ${outPath}`);
  await app.close();
}

void generate();
