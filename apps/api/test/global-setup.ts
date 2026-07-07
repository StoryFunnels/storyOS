import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Test database strategy (docs/architecture/overview.md → Testing):
 * - CI provides DATABASE_URL (GitHub Actions postgres service container)
 * - locally, Testcontainers spins up a disposable postgres:16-alpine
 * Migrations run once here; individual test files truncate what they touch.
 */
export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.DATABASE_URL;

  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
  }

  const pool = new Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();

  project.provide('databaseUrl', url);

  return async () => {
    await container?.stop();
  };
}
