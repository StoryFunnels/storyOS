import type { Pool } from 'pg';

/** The storage key of the one attachment seedBackupTenant creates. */
export const SEEDED_ATTACHMENT_KEY = 'ws/a.png';

/**
 * Seed one coherent tenant for the backup/restore tests (#322, #891): auth +
 * workspace spine + a resolved relation + an attachment row, which is what
 * scripts/backup-restore/integrity-checks.sql and backup.sh's row counts read.
 */
export async function seedBackupTenant(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ('u1', 'Ada', 'ada@example.com')`);
  await pool.query(
    `INSERT INTO "session" (id, expires_at, token, user_id) VALUES ('s1', now() + interval '1 day', 'tok1', 'u1')`,
  );
  const ws = (await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('WS', 'ws') RETURNING id`))
    .rows[0].id;
  const sp = (
    await pool.query(`INSERT INTO spaces (workspace_id, name, slug) VALUES ($1, 'S', 's') RETURNING id`, [ws])
  ).rows[0].id;
  const mk = async (slug: string) =>
    (
      await pool.query(
        `INSERT INTO databases (workspace_id, space_id, name, api_slug) VALUES ($1, $2, $3, $3) RETURNING id`,
        [ws, sp, slug],
      )
    ).rows[0].id;
  const dbA = await mk('a');
  const dbB = await mk('b');
  const rec = async (dbid: string, title: string) =>
    (await pool.query(`INSERT INTO records (database_id, title) VALUES ($1, $2) RETURNING id`, [dbid, title]))
      .rows[0].id;
  const r1 = await rec(dbA, 'one');
  const r2 = await rec(dbB, 'two');
  const rel = (
    await pool.query(
      `INSERT INTO relations (workspace_id, database_a_id, database_b_id, field_a_id, field_b_id, cardinality)
       VALUES ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), 'many_to_many') RETURNING id`,
      [ws, dbA, dbB],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO record_links (relation_id, from_record_id, to_record_id) VALUES ($1, $2, $3)`,
    [rel, r1, r2],
  );
  await pool.query(
    `INSERT INTO attachments (record_id, filename, size, mime, storage_key)
     VALUES ($1, 'a.png', 10, 'image/png', $2)`,
    [r1, SEEDED_ATTACHMENT_KEY],
  );
}
