import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';
import { buildOpenApiDocument } from './openapi.setup';

async function runMigrations() {
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const { join } = await import('node:path');
  const pool = new Pool({ connectionString: env().DATABASE_URL });
  await migrate(drizzle(pool), { migrationsFolder: join(__dirname, '..', 'drizzle') });
  // MN-087: retrofit the 'id' system field onto pre-existing databases. Must run
  // AFTER migrate() commits — Postgres forbids using the freshly-added 'id' enum
  // value in the same transaction it was added in. Idempotent (WHERE NOT EXISTS).
  await pool.query(`
    INSERT INTO fields (database_id, display_name, api_name, type, is_system, position)
    SELECT d.id, 'ID', 'id', 'id', true, -1 FROM databases d
    WHERE NOT EXISTS (SELECT 1 FROM fields f WHERE f.database_id = d.id AND f.api_name = 'id')
  `);
  await pool.end();

  console.log('migrations applied');
}

async function bootstrap() {
  if (env().RUN_MIGRATIONS) await runMigrations();
  // trustProxy is a NUMBER of hops, not `true` (MN-248). Caddy is the single
  // front proxy (MN-068), so trust exactly one hop: request.ip becomes the
  // address Caddy observed (the last entry Caddy appended to X-Forwarded-For).
  // Blanket-trusting (`true`) would honor the whole client-supplied XFF chain,
  // letting an attacker spoof their IP to scatter rate-limit buckets — the same
  // bypass one layer up.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 3 * 1024 * 1024, trustProxy: 1 }), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();

  const document = buildOpenApiDocument(app);
  app
    .getHttpAdapter()
    .getInstance()
    .get('/api/v1/openapi.json', async () => document);

  await app.listen(env().PORT, '0.0.0.0');
}

void bootstrap();
