import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_ATTACHMENT_KEY, seedBackupTenant } from './helpers/backup-seed';

/**
 * #891 / #892 — the SHIPPED scripts, end to end: backup.sh → restore.sh →
 * verify-restore.sh, on a real Compose project built from the repo's own
 * docker-compose.yml.
 *
 * backup-restore.test.ts proves pg_dump/pg_restore and integrity-checks.sql,
 * but never ran the scripts, so two bugs shipped that broke every real restore:
 * restore.sh `source`d a manifest whose unquoted `ATTACHMENTS=local volume …`
 * line bash runs as a command (#891), and verify-restore.sh split the
 * tab-separated counts.tsv on '|' (#892). Each check here is also shown to FAIL
 * when it should — a verifier that only ever passes proves nothing.
 *
 * Needs a Docker daemon with Compose v2 (GitHub's ubuntu runners have both).
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPTS = join(REPO, 'scripts/backup-restore');
const SOURCE = `sosbr${randomBytes(3).toString('hex')}`;
const CLONE = `${SOURCE}_clone`;
const LABEL = 'e2e';

let tmp: string;
let env: NodeJS.ProcessEnv;

interface RunResult {
  code: number;
  out: string;
}

/** Run a command, never throwing: the failure paths are what half of these tests assert. */
function run(cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd: REPO, env: { ...env, ...extraEnv }, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        // The scripts colour their [tag] PASS:/FAIL: prefixes; assert on the words.
        // eslint-disable-next-line no-control-regex
        done({ code, out: `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '') });
      },
    );
  });
}

async function mustRun(cmd: string, args: string[]): Promise<string> {
  const res = await run(cmd, args);
  if (res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.code}\n${res.out}`);
  return res.out;
}

/** A copy of the recovery point to tamper with, so each case starts from a good one. */
async function copyPoint(name: string): Promise<string> {
  const dir = join(tmp, 'variants', name);
  await cp(join(tmp, 'backups', LABEL), dir, { recursive: true });
  return dir;
}

/** restore.sh into the isolated clone project; it runs verify-restore.sh itself. */
const restore = (dir: string, project = CLONE) =>
  run('bash', [join(SCRIPTS, 'restore.sh'), dir, '--project', project]);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'storyos-backup-e2e-'));
  // Publish the source postgres on a random loopback port so the test can migrate
  // and seed it; COMPOSE_FILE reaches the scripts too, which run `docker compose -p`.
  await writeFile(
    join(tmp, 'publish.yml'),
    "services:\n  postgres:\n    ports: ['127.0.0.1::5432']\n",
  );
  env = {
    ...process.env,
    COMPOSE_FILE: `${join(REPO, 'docker-compose.yml')}:${join(tmp, 'publish.yml')}`,
    COMPOSE_PROJECT_NAME: SOURCE,
    BACKUPS_DIR: join(tmp, 'backups'),
    // docker-compose.yml requires these for the api service even when only
    // postgres is started; the scripts never use them.
    BETTER_AUTH_SECRET: 'e2e'.repeat(22),
    CONNECTIONS_MASTER_KEY: 'e2e'.repeat(22),
  };

  await mustRun('docker', ['compose', '-p', SOURCE, 'up', '-d', '--wait', 'postgres']);
  const hostPort = (await mustRun('docker', ['compose', '-p', SOURCE, 'port', 'postgres', '5432']))
    .trim()
    .split(':')
    .pop();
  const pool = new Pool({ connectionString: `postgres://storyos:storyos@127.0.0.1:${hostPort}/storyos` });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    await seedBackupTenant(pool);
  } finally {
    await pool.end();
  }

  // The live attachments volume, holding the one file the seeded row points at.
  await mustRun('docker', [
    'run', '--rm', '-v', `${SOURCE}_storyos_attachments:/data`, 'alpine',
    'sh', '-c', `mkdir -p "/data/$(dirname ${SEEDED_ATTACHMENT_KEY})" && echo png > /data/${SEEDED_ATTACHMENT_KEY}`,
  ]);

  await mustRun('bash', [join(SCRIPTS, 'backup.sh'), LABEL]);
}, 240_000);

afterAll(async () => {
  for (const project of [SOURCE, CLONE]) {
    await run('docker', ['compose', '-p', project, 'down', '-v']);
    await run('docker', ['volume', 'rm', `${project}_storyos_attachments`]);
  }
  if (tmp) await rm(tmp, { recursive: true, force: true });
}, 120_000);

describe('backup.sh → restore.sh → verify-restore.sh (#891, #892)', () => {
  it('writes a manifest that is safe to source', async () => {
    const manifest = join(tmp, 'backups', LABEL, 'manifest.env');
    expect(await readFile(manifest, 'utf8')).toContain(`ATTACHMENTS='local volume ${SOURCE}_storyos_attachments'`);
    const sourced = await run('bash', ['-c', 'set -euo pipefail; . "$1"; printf %s "$ATTACHMENTS"', '_', manifest]);
    expect(sourced).toEqual({ code: 0, out: `local volume ${SOURCE}_storyos_attachments` });
  });

  it('restores the recovery point and passes all three checks', async () => {
    const res = await restore(join(tmp, 'backups', LABEL));
    expect(res.out).toContain('PASS: structural integrity');
    expect(res.out).toContain('PASS: row counts match source for all 9 tables');
    expect(res.out).toContain('PASS: 1 attachment row(s) all have a file on disk');
    expect(res.out).toContain(`restore rehearsal SUCCEEDED for recovery point '${LABEL}'`);
    expect(res.code).toBe(0);
  }, 180_000);

  it('still restores a manifest written before the fix (unquoted values)', async () => {
    const dir = await copyPoint('legacy');
    const manifest = join(dir, 'manifest.env');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(/^(\w+)='(.*)'$/gm, '$1=$2'));
    expect(await readFile(manifest, 'utf8')).toContain(`ATTACHMENTS=local volume ${SOURCE}_storyos_attachments`);

    const res = await restore(dir);
    expect(res.out).toContain('PASS: row counts match source for all 9 tables');
    expect(res.code).toBe(0);
  }, 180_000);

  it('fails on row-count drift', async () => {
    const dir = await copyPoint('drift');
    const counts = join(dir, 'counts.tsv');
    await writeFile(counts, (await readFile(counts, 'utf8')).replace(/^records\t\d+$/m, 'records\t999'));
    expect(await readFile(counts, 'utf8')).toContain('records\t999\n');

    const res = await restore(dir);
    expect(res.out).toMatch(/row count drift on 'records': source=999 restored=2/);
    expect(res.code).not.toBe(0);
  }, 180_000);

  it('fails when an attachment file is missing from the archive', async () => {
    const dir = await copyPoint('no-files');
    // An empty archive with a manifest that vouches for it: the checksum passes,
    // so only the file check can catch it.
    await mustRun('tar', ['czf', join(dir, 'attachments.tgz'), '-C', join(tmp, 'variants'), '--files-from', '/dev/null']);
    const sha = (await mustRun('sha256sum', [join(dir, 'attachments.tgz')])).split(' ')[0];
    const manifest = join(dir, 'manifest.env');
    await writeFile(
      manifest,
      (await readFile(manifest, 'utf8')).replace(/^ATTACHMENTS_SHA256=.*$/m, `ATTACHMENTS_SHA256='${sha}'`),
    );

    const res = await restore(dir);
    expect(res.out).toContain('1 attachment file(s) missing from the restored volume');
    expect(res.code).not.toBe(0);
  }, 180_000);

  it('refuses a db.dump that does not match its checksum', async () => {
    const dir = await copyPoint('corrupt');
    await writeFile(join(dir, 'db.dump'), Buffer.concat([await readFile(join(dir, 'db.dump')), Buffer.from('x')]));

    const res = await restore(dir);
    expect(res.out).toContain('db.dump checksum mismatch');
    expect(res.code).not.toBe(0);
  }, 60_000);

  it('refuses to restore into the live project without --force', async () => {
    const res = await restore(join(tmp, 'backups', LABEL), SOURCE);
    expect(res.out).toContain(`refusing to restore into the LIVE project '${SOURCE}'`);
    expect(res.code).not.toBe(0);
  }, 60_000);
});
