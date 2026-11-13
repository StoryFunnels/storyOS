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
