import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgencySeedRefused, assertAgencyOwnership, guardAgencyOwnership, guardAgencyTarget, ownershipMarker } from '../src/seed/agency-guard';

/**
 * #1297 — who made the database. The name rules (seed-agency-guard.test.ts) say which names MAY be
 * seeded; the Postgres comment the shell scripts write right after `createdb` says which ones the
 * tooling really made. Before this, a hand-made `storyos_pinewood_x` holding other data matched the
 * name rules and the seed appended a second workspace and ten users to it.
 *
 * Every refusal and every keep below was checked by breaking the guard and watching its test fail
 * (see the PR).
 */
const db = 'storyos_pinewood_x';

describe('seed:agency ownership: the pure decision', () => {
  const refusesOwn = (comment: string | null, match: RegExp, name = db) => {
    expect(() => assertAgencyOwnership(name, comment)).toThrow(AgencySeedRefused);
    expect(() => assertAgencyOwnership(name, comment)).toThrow(match);
  };

  it('keeps a database marked stack, rig or template for its own name, with or without a detail', () => {
    for (const kind of ['stack', 'rig', 'template'] as const) {
      expect(() => assertAgencyOwnership(db, ownershipMarker(kind, db))).not.toThrow();
      expect(() => assertAgencyOwnership(db, `${ownershipMarker(kind, db)}; sha=abc123, migrations + seed:agency`)).not.toThrow();
    }
  });

  it('refuses an unmarked database and names the one-line adoption command', () => {
    refusesOwn('', /did not create it/);
    refusesOwn('', /psql -d postgres -c "COMMENT ON DATABASE storyos_pinewood_x IS 'pinewood-stack:storyos_pinewood_x'"/);
  });

  it('prints the template marker in the adoption hint for a template name', () => {
    refusesOwn('', /IS 'pinewood-template:storyos_agency_tpl'/, 'storyos_agency_tpl');
  });

  it("refuses somebody else's comment, a marker for another database, and near misses", () => {
    for (const comment of [
      'Quarterly reporting data',
      'pinewood-stack:storyos_pinewood',
      'pinewood-stack:storyos_pinewood_xy',
      'pinewood-stack:storyos_pinewood_x_2',
      'pinewood-cluster:storyos_pinewood_x',
      ' pinewood-stack:storyos_pinewood_x',
      'x pinewood-stack:storyos_pinewood_x',
      'pinewood-stack:storyos_pinewood_x detail without a semicolon',
    ]) {
      refusesOwn(comment, /did not create it/);
    }
  });

  it('refuses a database that does not exist', () => {
    refusesOwn(null, /does not exist/);
  });

  it('agrees with scripts/pinewood/lib.sh on which comments carry a marker', () => {
    const lib = resolve(__dirname, '../../../scripts/pinewood/lib.sh');
    const comments = [
      '', 'pinewood-stack:storyos_pinewood_x', 'pinewood-rig:storyos_pinewood_x', 'pinewood-template:storyos_pinewood_x',
      'pinewood-stack:storyos_pinewood_x; sha=1', 'pinewood-stack:storyos_pinewood_x;', 'pinewood-stack:storyos_pinewood_x ;',
      'pinewood-stack:storyos_pinewood_xy', 'pinewood-stack:storyos_pinewood', 'pinewood-cluster:storyos_pinewood_x',
      ' pinewood-stack:storyos_pinewood_x', 'pinewood-stack:storyos_pinewood_x;;', 'hand made',
    ];
    for (const comment of comments) {
      const shell = ['stack', 'rig', 'template'].some(
        (kind) =>
          spawnSync('bash', ['-c', `source "${lib}"; pw_comment_has_marker "$1" "$(pw_marker ${kind} "$2")"`, '_', comment, db], { encoding: 'utf8' }).status === 0,
      );
      let ts = true;
      try {
        assertAgencyOwnership(db, comment);
      } catch {
        ts = false;
      }
      expect(ts, `comment ${JSON.stringify(comment)}: shell says ${shell}`).toBe(shell);
    }
  });
});

describe('seed:agency ownership: where the command runs it', () => {
  // The command boots the whole app, so this reads the entry point rather than running it; the
  // built command was also run for real (PR description).
  it('asks before the dry-run plan is printed and before the app boots', () => {
    const src = readFileSync(resolve(__dirname, '../src/seed/agency.ts'), 'utf8');
    const ask = src.indexOf('await guardAgencyOwnership(');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(src.indexOf('guardAgencyTarget(process.env)'));
    expect(ask).toBeLessThan(src.indexOf("includes('--dry-run')"));
    expect(ask).toBeLessThan(src.indexOf('NestFactory.create'));
    expect(ask).toBeLessThan(src.indexOf('resolveSeedPassword(process.env)'));
  });
});

describe('seed:agency ownership: the real Postgres comment', () => {
  const adminUrl = inject('databaseUrl');
  const made: string[] = [];
  const urlFor = (name: string) => {
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    return u.toString();
  };
  let admin: Pool;
  beforeAll(() => {
    admin = new Pool({ connectionString: adminUrl });
  });
  afterAll(async () => {
    for (const name of made) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  });
  async function make(name: string, comment?: string) {
    await admin.query(`CREATE DATABASE "${name}"`);
    made.push(name);
    if (comment !== undefined) await admin.query(`COMMENT ON DATABASE "${name}" IS '${comment}'`);
  }
  const guard = (name: string) => guardAgencyOwnership({ DATABASE_URL: urlFor(name) }, { database: name, host: 'localhost' });

  it('refuses a hand-made database with the right name and no marker (the gap that was name-only)', async () => {
    await make('storyos_pinewood_marek_own1');
    await expect(guard('storyos_pinewood_marek_own1')).rejects.toThrow(AgencySeedRefused);
    await expect(guard('storyos_pinewood_marek_own1')).rejects.toThrow(/did not create it.*COMMENT ON DATABASE storyos_pinewood_marek_own1/);
  });

  it('refuses a database commented by somebody else, and a marker copied from another database', async () => {
    await make('storyos_pinewood_marek_own2', 'client reporting');
    await make('storyos_pinewood_marek_own3', 'pinewood-stack:storyos_pinewood_marek_own2');
    await expect(guard('storyos_pinewood_marek_own2')).rejects.toThrow(/did not create it/);
    await expect(guard('storyos_pinewood_marek_own3')).rejects.toThrow(/did not create it/);
  });

  it('keeps a marked stack, rig and template database, and a re-run is not refused either', async () => {
    await make('storyos_pinewood_marek_own4', 'pinewood-stack:storyos_pinewood_marek_own4');
    await make('storyos_pinewood_marek_own5', 'pinewood-rig:storyos_pinewood_marek_own5');
    await make(
      'storyos_agency_tpl_marek_own6',
      'pinewood-template:storyos_agency_tpl_marek_own6; sha=abc, migrations + seed:agency, built=2026-11-18T10:00:00Z',
    );
    for (const name of ['storyos_pinewood_marek_own4', 'storyos_pinewood_marek_own5', 'storyos_agency_tpl_marek_own6']) {
      await expect(guard(name)).resolves.toBeUndefined();
      await expect(guard(name)).resolves.toBeUndefined();
    }
  });

  it('refuses a database that does not exist, which is not "nothing to protect"', async () => {
    await expect(guard('storyos_pinewood_marek_absent')).rejects.toThrow(/does not exist/);
  });

  it('refuses when Postgres does not answer, rather than guessing the database is absent', async () => {
    const dead = 'postgres://dev@localhost:1/storyos_pinewood_marek_own7';
    await expect(guardAgencyOwnership({ DATABASE_URL: dead }, { database: 'storyos_pinewood_marek_own7', host: 'localhost' })).rejects.toThrow(
      /cannot ask Postgres/,
    );
  });

  it('leaves the name rules in front: a marker never makes a protected or unrelated name seedable', () => {
    expect(() => guardAgencyTarget({ DATABASE_URL: 'postgres://dev@localhost:5432/storyos' })).toThrow(/protected/);
    expect(() => guardAgencyTarget({ DATABASE_URL: 'postgres://dev@localhost:5432/storyos_test_local' })).toThrow(/not a pinewood-named database/);
  });
});
