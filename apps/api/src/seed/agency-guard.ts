/**
 * #1297 — what `seed:agency` is allowed to touch, and where its throwaway password comes from.
 *
 * Mirrors scripts/pinewood/lib.sh (pw_assert_stack_db, pw_assert_template_db, pw_assert_local_host)
 * rule for rule, in TypeScript, because the seed is also runnable on its own and must not lean on
 * the shell wrapper having checked first. The two copies are held together by a test that feeds the
 * same names to both (apps/api/test/seed-agency-guard.test.ts reads lib.sh and compares).
 *
 * The seed writes a lot of fake people and fake clients into whatever database it is pointed at.
 * Pointed at the shared founder database, or a hosted one, that is a disaster nobody can undo, so
 * the answer to "which database?" is a closed list of names, not a blocklist: anything not named
 * `storyos_pinewood*` (the standing stack) or `storyos_agency_tpl*` (the template the stack's
 * scripts build and seed) is refused before the app boots.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

export class AgencySeedRefused extends Error {
  constructor(reason: string) {
    super(`seed:agency: REFUSED: ${reason}`);
    this.name = 'AgencySeedRefused';
  }
}

/** Same list as PW_PROTECTED_DBS in scripts/pinewood/lib.sh. `storyos` is the shared founder database. */
export const PROTECTED_DATABASES = ['postgres', 'template0', 'template1', 'umh_analytics', 'storyos'] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `storyos_pinewood` or `storyos_pinewood_<lowercase, digits, underscores>`. */
const STACK_DB = /^storyos_pinewood(_[a-z0-9_]+)?$/;
/** `storyos_agency_tpl` or `storyos_agency_tpl_<...>`: the template pinewood-template.sh seeds. */
const TEMPLATE_DB = /^storyos_agency_tpl(_[a-z0-9_]+)?$/;

export function assertAgencyDatabase(name: string): void {
  if ((PROTECTED_DATABASES as readonly string[]).includes(name)) {
    throw new AgencySeedRefused(`database '${name}' is protected; this command only touches storyos_pinewood* (or the storyos_agency_tpl* template)`);
  }
  if (!STACK_DB.test(name) && !TEMPLATE_DB.test(name)) {
    throw new AgencySeedRefused(
      `database '${name}' is not a pinewood-named database (expected storyos_pinewood, storyos_pinewood_*, or the storyos_agency_tpl* template)`,
    );
  }
}

export function assertLocalHost(host: string): void {
  if (!LOCAL_HOSTS.has(host)) {
    throw new AgencySeedRefused(`Postgres host '${host}' is not local (localhost, 127.0.0.1 or ::1 only)`);
  }
}

/**
 * WHO MADE THE DATABASE (#1297, the follow-up on the name-only guard).
 *
 * A name is not ownership: a hand-made `storyos_pinewood_x` holding somebody's other data matches
 * the name rules, and the seed would append a second workspace and ten users to it. So the shell
 * scripts record what they create in the database's own Postgres comment, written right after
 * `createdb` (`pinewood-<kind>:<db>`, kind = stack | rig | template, optionally followed by
 * `; detail`), and this repeats the rule scripts/pinewood/lib.sh applies (pw_comment_has_marker,
 * pw_require_ours): a database whose comment is not exactly one of those markers for ITS OWN name is
 * somebody else's, and the seed refuses it. The name rules above run first and win, so a forged
 * marker on a protected or unrelated name still refuses.
 */
export const OWNERSHIP_KINDS = ['stack', 'rig', 'template'] as const;
export type OwnershipKind = (typeof OWNERSHIP_KINDS)[number];

export function ownershipMarker(kind: OwnershipKind, database: string): string {
  return `pinewood-${kind}:${database}`;
}

/** Exactly the marker, or the marker followed by `;` and a detail. Same rule as pw_comment_has_marker. */
export function commentHasMarker(comment: string, marker: string): boolean {
  return comment === marker || comment.startsWith(`${marker};`);
}

/** The one-line adoption command lib.sh prints, for the kind this database name belongs to. */
export function adoptionCommand(database: string): string {
  const kind: OwnershipKind = TEMPLATE_DB.test(database) ? 'template' : 'stack';
  return `psql -d postgres -c "COMMENT ON DATABASE ${database} IS '${ownershipMarker(kind, database)}'"`;
}

/** `comment` is the database's Postgres comment, or null when the database does not exist. */
export function assertAgencyOwnership(database: string, comment: string | null): void {
  if (comment === null) {
    throw new AgencySeedRefused(`database '${database}' does not exist; create and migrate it with scripts/pinewood/pinewood-up.sh (or pinewood-template.sh) first`);
  }
  if (OWNERSHIP_KINDS.some((kind) => commentHasMarker(comment, ownershipMarker(kind, database)))) return;
  throw new AgencySeedRefused(
    `database '${database}' already exists and this tooling did not create it (its comment is not '${ownershipMarker('stack', database)}', ` +
      `'${ownershipMarker('rig', database)}' or '${ownershipMarker('template', database)}'); refusing to seed it. ` +
      `A database you made by hand is adopted deliberately: ${adoptionCommand(database)}`,
  );
}

/**
 * Ask Postgres for the comment of the database the URL names. A database that is not there is
 * `null`; a Postgres that does not answer is a refusal, never "absent": unresolvable must not read
 * as "nothing to protect".
 */
export async function readDatabaseComment(connectionString: string, database: string): Promise<string | null> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const res = await client.query<{ comment: string | null }>(
      `SELECT coalesce(shobj_description(oid, 'pg_database'), '') AS comment FROM pg_database WHERE datname = current_database()`,
    );
    return res.rows[0]?.comment ?? '';
  } catch (err) {
    if ((err as { code?: string }).code === '3D000') return null;
    throw new AgencySeedRefused(
      `cannot ask Postgres whether '${database}' was made by this tooling (${(err as Error).message}); refusing rather than guessing`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The decision the command runs before the app boots, dry run included (the shell's plan does the same). */
export async function guardAgencyOwnership(env: Record<string, string | undefined>, target: AgencyTarget): Promise<void> {
  assertAgencyOwnership(target.database, await readDatabaseComment(env.DATABASE_URL!, target.database));
}

export interface AgencyTarget {
  database: string;
  host: string;
}

/**
 * Decide from the environment the process was started with, and only from it.
 *
 * An UNSET DATABASE_URL is a refusal, not "use the default": the API's own default is the shared
 * founder database, which is precisely the case this guard exists for. A `host` or `hostaddr`
 * query parameter is refused too: node-postgres lets it override the authority part of the URL, so
 * `postgres://u@localhost/storyos_pinewood?host=db.prod.internal` would pass a name-and-host check
 * and then connect somewhere else.
 */
export function guardAgencyTarget(env: Record<string, string | undefined>): AgencyTarget {
  if (env.NODE_ENV === 'production') {
    throw new AgencySeedRefused('NODE_ENV is production; this command never runs against a production deployment');
  }
  const raw = env.DATABASE_URL;
  if (!raw) {
    throw new AgencySeedRefused(
      'DATABASE_URL is not set. The API would fall back to the shared founder database, so this command refuses to guess; set it to a storyos_pinewood* database',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgencySeedRefused('DATABASE_URL is not a parseable URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new AgencySeedRefused(`DATABASE_URL protocol '${url.protocol}' is not postgres`);
  }
  for (const key of ['host', 'hostaddr', 'dbname', 'service']) {
    if (url.searchParams.has(key)) {
      throw new AgencySeedRefused(`DATABASE_URL carries a '${key}' query parameter that could redirect the connection; refusing`);
    }
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assertAgencyDatabase(database);
  assertLocalHost(url.hostname);
  return { database, host: url.hostname };
}

const ENV_KEY = 'PINEWOOD_SEED_PASSWORD';

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * The one throwaway password every seeded login shares. It protects a local database of invented
 * people and nothing else, and it is never in the repository:
 *
 *   1. PINEWOOD_SEED_PASSWORD in the environment, else
 *   2. the same key in the stack's throwaway env file (PINEWOOD_ENV_FILE, default
 *      ~/storyos-envs/pinewood.env: outside every clone, mode 600), else
 *   3. a fresh random one, appended to that file so the next run and the person signing in can read it.
 *
 * It refuses an env file that sits inside a git checkout, so a misconfigured PINEWOOD_ENV_FILE
 * cannot put a password under version control.
 */
export function resolveSeedPassword(env: Record<string, string | undefined>): { password: string; source: 'env' | 'file' | 'generated'; file: string } {
  const file = env.PINEWOOD_ENV_FILE ?? join(env.HOME ?? homedir(), 'storyos-envs', 'pinewood.env');
  if (env[ENV_KEY]) return { password: env[ENV_KEY]!, source: 'env', file };
  if (insideGitCheckout(file)) {
    throw new AgencySeedRefused(`the env file '${file}' is inside a git checkout; it must live outside every repository`);
  }
  if (existsSync(file)) {
    const stored = parseEnvFile(readFileSync(file, 'utf8'))[ENV_KEY];
    if (stored) return { password: stored, source: 'file', file };
  }
  const password = randomBytes(18).toString('base64url');
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${ENV_KEY}=${password}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { password, source: 'generated', file };
}

function insideGitCheckout(path: string): boolean {
  let dir = dirname(path);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}
