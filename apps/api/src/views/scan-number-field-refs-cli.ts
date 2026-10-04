/**
 * #764 Phase A — prints the read-only per-workspace census from
 * scan-number-field-refs-report.ts. Reports; cannot write (see that file).
 *
 *     pnpm --filter @storyos/api views:scan-number-refs            # human table
 *     pnpm --filter @storyos/api views:scan-number-refs -- --json  # machine readable
 *
 * It scans whatever DATABASE_URL names, and says which one first, so a result is
 * never ambiguous about where it came from. Posting it on the ticket: copy the
 * output verbatim and add the git sha the build came from.
 */
// #658: MUST be the first import — without it apps/api/.env is never read and
// DATABASE_URL silently falls back to the shared founder dev database.
import '../config/load-env';
import { env } from '../config/env';
import { createDb } from '../db/client';
import { reportNumberRefsByWorkspace } from './scan-number-field-refs-report';

/** host/database only — never the credentials. */
function describeTarget(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const target = describeTarget(env().DATABASE_URL);
  const { db, pool } = createDb(env().DATABASE_URL);
  try {
    const report = await reportNumberRefsByWorkspace(db);
    if (json) {
      console.log(JSON.stringify({ target, ...report }, null, 2));
      return;
    }
    const t = report.totals;
    console.log(
      [
        '',
        "Stored view configs referencing the deprecated `number` field (#764, READ-ONLY):",
        `  database:  ${target}`,
        `  scanned:   ${report.scannedAt}`,
        `  scope:     live (non-trashed) views only; counts only, no names or ids`,
        '',
        '  workspace                              views  referencing  user-field-db  space-unresolved',
        ...report.workspaces.map(
          (w) =>
            `  ${w.workspaceId.padEnd(36)} ${String(w.viewsScanned).padStart(6)} ${String(w.referencing).padStart(12)} ${String(w.userFieldDatabase).padStart(14)} ${String(w.spaceViewUnresolved).padStart(17)}`,
        ),
        '',
        `  TOTAL: ${t.referencing} view(s) reference the deprecated field, in ${t.workspacesReferencing} of ${t.workspaces} workspace(s), out of ${t.viewsScanned} views.`,
        `  Not counted as references: ${t.userFieldDatabase} in a database where \`number\` is the user's own field.`,
        `  Ambiguous, needs a human: ${t.spaceViewUnresolved} space-level view(s).`,
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Number-ref scan failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
