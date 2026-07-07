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
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('migrations applied');
}

async function bootstrap() {
  if (env().RUN_MIGRATIONS) await runMigrations();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 3 * 1024 * 1024 }), {
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
