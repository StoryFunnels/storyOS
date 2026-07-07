import { inject } from 'vitest';
import type { Pool } from 'pg';
import { createDb } from '../../src/db/client';

export function connectTestDb() {
  return createDb(inject('databaseUrl'));
}

/** Wipe all tenant data between test files. Cascades cover child tables. */
export async function truncateAll(pool: Pool) {
  await pool.query('TRUNCATE TABLE workspaces CASCADE');
}
