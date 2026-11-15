import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgencySeedRefused, guardAgencyTarget, resolveSeedPassword } from '../src/seed/agency-guard';

/**
 * #1297. The seed writes a lot of invented people into whatever database it is pointed at, so the
 * answer to "which database?" is a closed list. Every refusal below was checked by breaking the guard
 * and watching its test fail (see the PR).
 */
const url = (db: string, host = 'localhost') => `postgres://dev@${host}:5432/${db}`;
const refuses = (env: Record<string, string | undefined>, match: RegExp) => {
  expect(() => guardAgencyTarget(env)).toThrow(AgencySeedRefused);
  expect(() => guardAgencyTarget(env)).toThrow(match);
};

describe('seed:agency refusals', () => {
  it('accepts the standing stack, a suffixed pinewood database, and the template', () => {
    expect(guardAgencyTarget({ DATABASE_URL: url('storyos_pinewood') }).database).toBe('storyos_pinewood');
    expect(guardAgencyTarget({ DATABASE_URL: url('storyos_pinewood_test_marek_7') }).database).toBe('storyos_pinewood_test_marek_7');
    expect(guardAgencyTarget({ DATABASE_URL: url('storyos_agency_tpl', '127.0.0.1') }).host).toBe('127.0.0.1');
    expect(guardAgencyTarget({ DATABASE_URL: url('storyos_pinewood', '[::1]') }).database).toBe('storyos_pinewood');
  });

  it('refuses an inherited DATABASE_URL that points at the shared founder database', () => {
    refuses({ DATABASE_URL: 'postgres://storyos:storyos@localhost:5432/storyos' }, /protected/);
  });

  it('refuses every other protected or unrelated database', () => {
    for (const db of ['postgres', 'template0', 'template1', 'umh_analytics']) refuses({ DATABASE_URL: url(db) }, /protected/);
    for (const db of ['storyos_dev', 'storyos_marek_1297', 'storyos_pinewoodx', 'storyos_pinewood_UPPER', 'pinewood', 'storyos_agency_tplx', 'storyos_test_local']) {
      refuses({ DATABASE_URL: url(db) }, /not a pinewood-named database/);
    }
  });

  it('refuses when DATABASE_URL is unset, because the API default is the founder database', () => {
    refuses({}, /DATABASE_URL is not set/);
    refuses({ DATABASE_URL: '' }, /DATABASE_URL is not set/);
  });

  it('refuses a Postgres host that is not local', () => {
    refuses({ DATABASE_URL: url('storyos_pinewood', 'db.prod.internal') }, /not local/);
    refuses({ DATABASE_URL: url('storyos_pinewood', '10.0.0.5') }, /not local/);
  });

  it('refuses a query parameter that could redirect the connection after the name was checked', () => {
    refuses({ DATABASE_URL: `${url('storyos_pinewood')}?host=db.prod.internal` }, /query parameter/);
    refuses({ DATABASE_URL: `${url('storyos_pinewood')}?hostaddr=10.0.0.5` }, /query parameter/);
    refuses({ DATABASE_URL: `${url('storyos_pinewood')}?dbname=storyos` }, /query parameter/);
  });

  it('refuses production and a non-postgres or unparseable URL', () => {
    refuses({ DATABASE_URL: url('storyos_pinewood'), NODE_ENV: 'production' }, /production/);
    refuses({ DATABASE_URL: 'mysql://dev@localhost/storyos_pinewood' }, /protocol/);
    refuses({ DATABASE_URL: 'not a url' }, /parseable/);
  });

  it('agrees with scripts/pinewood/lib.sh on which names are the stack or the template', () => {
    const lib = resolve(__dirname, '../../../scripts/pinewood/lib.sh');
    expect(existsSync(lib)).toBe(true);
    const bash = (fn: string, name: string) =>
      spawnSync('bash', ['-c', `source "${lib}"; ${fn} "$1"`, '_', name], { encoding: 'utf8' }).status === 0;
    const names = [
      'storyos_pinewood', 'storyos_pinewood_a1', 'storyos_pinewood_', 'storyos_pinewoodx', 'storyos', 'postgres', 'umh_analytics',
      'storyos_agency_tpl', 'storyos_agency_tpl_x', 'storyos_agency_tplx', 'storyos_marek_1297', 'storyos_pinewood_Bad',
    ];
    for (const name of names) {
      const shellAccepts = bash('pw_assert_stack_db', name) || bash('pw_assert_template_db', name);
      let tsAccepts = true;
      try {
        guardAgencyTarget({ DATABASE_URL: url(name) });
      } catch {
        tsAccepts = false;
      }
      expect(tsAccepts, `${name}: shell says ${shellAccepts}`).toBe(shellAccepts);
    }
  });
});

describe('seed:agency password', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'pw-seed-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('prefers the environment, then the throwaway file, then generates and stores one (mode 600)', () => {
    const dir = tmp();
    const file = join(dir, 'pinewood.env');
    expect(resolveSeedPassword({ PINEWOOD_SEED_PASSWORD: 'from-env', PINEWOOD_ENV_FILE: file }).source).toBe('env');
    expect(existsSync(file)).toBe(false);

    const first = resolveSeedPassword({ PINEWOOD_ENV_FILE: file });
    expect(first.source).toBe('generated');
    expect(first.password.length).toBeGreaterThanOrEqual(20);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(`PINEWOOD_SEED_PASSWORD=${first.password}`);

    const second = resolveSeedPassword({ PINEWOOD_ENV_FILE: file });
    expect(second).toMatchObject({ source: 'file', password: first.password });
  });

  it('keeps the other secrets already in that file', () => {
    const dir = tmp();
    const file = join(dir, 'pinewood.env');
    writeFileSync(file, 'BETTER_AUTH_SECRET=abc\nCONNECTIONS_MASTER_KEY=def', { mode: 0o600 });
    resolveSeedPassword({ PINEWOOD_ENV_FILE: file });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('BETTER_AUTH_SECRET=abc');
    expect(text).toContain('CONNECTIONS_MASTER_KEY=def\n');
    expect(text).toContain('PINEWOOD_SEED_PASSWORD=');
  });

  it('tightens a looser mode on an env file that already exists', () => {
    const dir = tmp();
    const file = join(dir, 'pinewood.env');
    writeFileSync(file, 'BETTER_AUTH_SECRET=abc\n', { mode: 0o644 });
    resolveSeedPassword({ PINEWOOD_ENV_FILE: file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses an env file that sits inside a git checkout, so a password can never be committed', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.git'));
    expect(() => resolveSeedPassword({ PINEWOOD_ENV_FILE: join(dir, 'nested', 'pinewood.env') })).toThrow(/inside a git checkout/);
    expect(existsSync(join(dir, 'nested'))).toBe(false);
  });
});
