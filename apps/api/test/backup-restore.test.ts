import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seedBackupTenant } from './helpers/backup-seed';

/**
 * Drift guard for the documented backup → restore → integrity procedure (#322).
 *
 * This does NOT mock the round-trip: it stands up a real postgres:16-alpine
 * (the same image docker-compose.yml pins), migrates it, seeds a workspace with
 * users/sessions, records, a relation with a link, and an attachment row, then
 * runs the ACTUAL `pg_dump -Fc` + `pg_restore` the shipped restore.sh runs —
 * inside the container, with the real client binaries — into a separate
 * database, and finally executes the SAME scripts/backup-restore/integrity-
 * checks.sql that restore.sh runs in production.
 *
 * So if the schema moves under those checks (a table renamed, an FK dropped),
 * this test — not a self-hosting operator at 2am — is what goes red. Full
 * compose-in-CI (api/web/caddy containers, the volume tar) is deliberately out
 * of scope here; that layer is documented and the shell scripts are the
 * executable spec. See the PR body for exactly what is/ isn't exercised.
 */

const CHECKS_SQL = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/backup-restore/integrity-checks.sql'),
  'utf8',
);

const DB = 'storyos';
const RESTORED = 'restored';
const USER = 'storyos';
const PASS = 'storyos';

let container: StartedPostgreSqlContainer;

async function exec(cmd: string) {
  const res = await container.exec(['sh', '-c', `PGPASSWORD=${PASS} ${cmd}`]);
  if (res.exitCode !== 0) {
    throw new Error(`exec failed (${res.exitCode}): ${cmd}\n${res.output}`);
  }
  return res.output;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase(DB)
    .withUsername(USER)
    .withPassword(PASS)
    .start();

  // Migrate the source DB exactly as the api container does on boot.
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

const TABLES = [
  'user',
  'session',
  'workspaces',
  'databases',
  'records',
  'relations',
  'record_links',
  'attachments',
];

async function counts(pool: Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    out[t] = Number((await pool.query(`SELECT count(*) FROM "${t}"`)).rows[0].count);
  }
  return out;
}

describe('backup → restore → integrity (documented procedure, #322)', () => {
  it('restores a matching database and passes every integrity check', async () => {
    const source = new Pool({ connectionString: container.getConnectionUri() });
    await seedBackupTenant(source);
    const before = await counts(source);
    await source.end();

    // The real backup + restore commands from restore.sh, using the container's
    // own pg_dump / pg_restore binaries — into a fresh, isolated database.
    await exec(`pg_dump -h 127.0.0.1 -U ${USER} -Fc ${DB} -f /tmp/db.dump`);
    await exec(`psql -h 127.0.0.1 -U ${USER} -d postgres -c 'CREATE DATABASE ${RESTORED}'`);
    await exec(`pg_restore -h 127.0.0.1 -U ${USER} -d ${RESTORED} --no-owner /tmp/db.dump`);

    const restoredUri = new URL(container.getConnectionUri());
    restoredUri.pathname = `/${RESTORED}`;
    const restored = new Pool({ connectionString: restoredUri.toString() });
    try {
      // 1. Row-count parity — the pair came back whole.
      const after = await counts(restored);
      expect(after).toEqual(before);
      expect(after.records).toBe(2);
      expect(after.record_links).toBe(1);

      // 2. Structural integrity — the SHIPPED integrity-checks.sql must not throw.
      await expect(restored.query(CHECKS_SQL)).resolves.toBeDefined();

      // 3. The check has teeth: a restore that lost its auth data must FAIL.
      await restored.query('TRUNCATE "user" CASCADE');
      await expect(restored.query(CHECKS_SQL)).rejects.toThrow(/auth check failed/);
    } finally {
      await restored.end();
    }
  }, 120_000);
});
