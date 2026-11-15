import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';

/**
 * ticket #1295 — `{rec}` accepts the record's public number as well as its uuid, on EVERY `records/{rec}/...` route, through one resolver
 * (common/record-ref.ts, applied once by WorkspaceAccessGuard). The number is scoped to the `{db}` in the path and is answered under exactly
 * the rules of the record's uuid: a record the caller cannot read is a 404 byte-identical to a number that does not exist.
 *
 * A test without a GUEST fixture, or without a MEMBER on a RESTRICTED database, proves nothing about access (CLAUDE.md), so both are here,
 * and the matrix is run for a session admin, a session member, a PAT member, a bound PAT and a guest.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let ws: string, general: string, openDb: string, secretDb: string, otherDb: string;
let openRec: { id: string; number: number }, secretRec: { id: string; number: number }, otherRec: { id: string; number: number };
let bob: Person, gina: Person, ghost: Person;
interface Caller { label: string; token: string }
const callers: Caller[] = [];

const adm = (m: string, u: string, p?: unknown) => call(app, owner.token, m, u, p);
const mk = async (m: string, u: string, p?: unknown) => {
  const r = await adm(m, u, p);
  if (r.statusCode >= 300) throw new Error(`fixture ${m} ${u}: ${r.statusCode} ${r.body}`);
  return r.json();
};
/** status + body, minus the per-request id, so two answers can be compared byte for byte. */
const answer = (r: { statusCode: number; body: string }) => ({ s: r.statusCode, b: r.body.replace(/"request_id":"[^"]*"/, '"request_id":"-"') });

/** every GET under a record that takes `{rec}`, the family the docs and the MCP describe as "uuid or public number". */
const GET_TAILS = ['', '/comments', '/versions', '/activity', '/watchers', '/attachments', '/branch-name', '/backlinks', '/document'];

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Byno Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Byno WS' })).json().id;
  general = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  openDb = (await mk('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Open' })).id;
  secretDb = (await mk('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Payroll' })).id;
  otherDb = (await mk('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Other' })).id;
  // numbers are per database: give every database a record numbered 1, and the open one a second, so a number can be tried in the WRONG database
  const rec = async (db: string, name: string) => {
    const j = await mk('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name } });
    return { id: j.id as string, number: j.number as number };
  };
  openRec = await rec(openDb, 'open one');
  await rec(openDb, 'open two');
  secretRec = await rec(secretDb, 'Salaries');
  otherRec = await rec(otherDb, 'other one');
  await setRestricted(app, owner.token, ws, 'database', secretDb);

  bob = await joinAs(app, owner.token, ws, 'Byno Bob', 'member');
  gina = await joinAs(app, owner.token, ws, 'Byno Gina', 'guest', [{ database_id: openDb, role: 'viewer' }]);
  ghost = await joinAs(app, owner.token, ws, 'Byno Ghost', 'guest', [{ database_id: otherDb, role: 'viewer' }]);
  const pat = async (token: string, resource_scope?: unknown) => {
    const r = await call(app, token, 'POST', '/me/tokens', { name: 'byno', workspace_id: ws, scope: 'admin', ...(resource_scope ? { resource_scope } : {}) });
    if (r.statusCode >= 300) throw new Error(`pat: ${r.statusCode} ${r.body}`);
    return r.json().token as string;
  };
  callers.push({ label: 'admin session', token: owner.token });
  callers.push({ label: 'member session', token: bob.token });
  callers.push({ label: 'member PAT', token: await pat(bob.token) });
  callers.push({ label: 'member PAT bound to the open database', token: await pat(bob.token, { database_ids: [openDb] }) });
  callers.push({ label: 'guest with a grant on the open database', token: gina.token });
  callers.push({ label: 'guest with a grant on another database', token: ghost.token });
});

afterAll(async () => {
  await app?.close();
});

const rp = (db: string, rec: string | number, tail = '') => `/workspaces/${ws}/databases/${db}/records/${rec}${tail}`;

describe('ticket #1295: a number answers exactly as its uuid does, on every records/{rec} GET, for every caller', () => {
  for (const database of ['open', 'secret'] as const) {
    it(`the ${database} database's record: number and uuid agree for admin, member, PAT, bound PAT and both guests`, async () => {
      const db = database === 'open' ? openDb : secretDb;
      const r = database === 'open' ? openRec : secretRec;
      const seen: Record<string, number> = {};
      for (const c of callers) {
        for (const tail of GET_TAILS) {
          const byUuid = answer(await call(app, c.token, 'GET', rp(db, r.id, tail)));
          const byNumber = answer(await call(app, c.token, 'GET', rp(db, r.number, tail)));
          expect(byNumber, `${c.label} GET ${tail || '/'}`).toEqual(byUuid);
          if (tail === '') seen[c.label] = byNumber.s;
        }
      }
      // MUST KEEP: the number really resolves for who can read it, and stays a 404 for who cannot (a pass of "both 404" would prove nothing)
      if (database === 'open') {
        expect(seen).toMatchObject({ 'admin session': 200, 'member session': 200, 'member PAT': 200, 'member PAT bound to the open database': 200, 'guest with a grant on the open database': 200 });
        expect(seen['guest with a grant on another database']).toBe(404);
      } else {
        expect(seen['admin session']).toBe(200);
        for (const l of ['member session', 'member PAT', 'guest with a grant on the open database', 'guest with a grant on another database'])
          expect(seen[l], l).toBe(404);
        // a token bound away from this database is refused at its boundary, by number as by uuid (the equality above)
        expect(seen['member PAT bound to the open database']).toBe(403);
      }
    });
  }

  it('the by-number answer is the whole record, not a stub', async () => {
    const byNumber = (await call(app, bob.token, 'GET', rp(openDb, openRec.number))).json();
    expect(byNumber).toMatchObject({ id: openRec.id, number: openRec.number });
    expect(byNumber.title).toBe('open one');
  });
});

describe('ticket #1295: no existence oracle by number', () => {
  it('a number of a record the caller cannot read is byte-identical to a number that does not exist, for everyone who cannot read it', async () => {
    for (const c of callers.filter((x) => x.label !== 'admin session')) {
      for (const tail of GET_TAILS) {
        const secret = answer(await call(app, c.token, 'GET', rp(secretDb, secretRec.number, tail)));
        const missing = answer(await call(app, c.token, 'GET', rp(secretDb, 987654, tail)));
        expect(secret, `${c.label} ${tail || '/'}`).toEqual(missing);
      }
    }
  });

  it('on a readable database an unknown number says what an unknown uuid says', async () => {
    const byNumber = answer(await call(app, bob.token, 'GET', rp(openDb, 987654)));
    const byUuid = answer(await call(app, bob.token, 'GET', rp(openDb, '00000000-0000-4000-8000-000000000099')));
    expect(byNumber).toEqual(byUuid);
    expect(byNumber.s).toBe(404);
  });

  it('a number is scoped to the {db} in the path: another database never lends its record', async () => {
    // otherDb/1 and openDb/1 are different records; openDb's number 2 does not exist in otherDb
    expect(otherRec.number).toBe(openRec.number);
    const own = (await call(app, owner.token, 'GET', rp(otherDb, otherRec.number))).json();
    expect(own.id).toBe(otherRec.id);
    const absent = answer(await call(app, owner.token, 'GET', rp(otherDb, 2)));
    expect(absent.s).toBe(404);
    // and a number never reaches across the restricted boundary by borrowing a readable database's path
    const viaWrongDb = answer(await call(app, bob.token, 'GET', rp(secretDb, 2)));
    const missing = answer(await call(app, bob.token, 'GET', rp(secretDb, 987654)));
    expect(viaWrongDb).toEqual(missing);
  });

  it('a number in a workspace the caller is not part of is the same 404 as an unknown uuid there', async () => {
    const stranger = await signUpUser(app, 'Byno Stranger');
    const byNumber = answer(await call(app, stranger.token, 'GET', rp(openDb, openRec.number)));
    const byUuid = answer(await call(app, stranger.token, 'GET', rp(openDb, openRec.id)));
    expect(byNumber).toEqual(byUuid);
    expect(byNumber.s).toBe(404);
  });
});

describe('ticket #1295: what is NOT a number stays what it was', () => {
  it.each(['abc', '0', '-1', '1.5', '007', '99999999999999999999', '1e3'])('"%s" is a 404 "Record not found", never a 500', async (junk) => {
    const r = await call(app, bob.token, 'GET', rp(openDb, junk));
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe('Record not found');
  });
});

describe('ticket #1295: the write routes take a number too, and write to the same record', () => {
  it('comment, edit, watch, duplicate and delete by number act on the record the uuid names', async () => {
    const created = await mk('POST', `/workspaces/${ws}/databases/${openDb}/records`, { values: { name: 'by number writes' } });
    const n = created.number as number;
    const c = await call(app, bob.token, 'POST', rp(openDb, n, '/comments'), { body: [{ type: 'text', text: 'hello by number' }] });
    expect(c.statusCode).toBe(201);
    const listed = (await call(app, bob.token, 'GET', rp(openDb, created.id, '/comments'))).json();
    expect(JSON.stringify(listed)).toContain('hello by number');

    const p = await call(app, bob.token, 'PATCH', rp(openDb, n), { values: { name: 'renamed by number' } });
    expect(p.statusCode).toBe(200);
    expect((await call(app, bob.token, 'GET', rp(openDb, created.id))).json().title).toBe('renamed by number');

    expect((await call(app, bob.token, 'POST', rp(openDb, n, '/watch'))).statusCode).toBeLessThan(300);
    const dup = await call(app, bob.token, 'POST', rp(openDb, n, '/duplicate'), {});
    expect(dup.statusCode).toBeLessThan(300);
    expect(dup.json().id).not.toBe(created.id);

    // a guest with viewer cannot write by number any more than by uuid
    const g = await call(app, gina.token, 'PATCH', rp(openDb, n), { values: { name: 'nope' } });
    const gUuid = await call(app, gina.token, 'PATCH', rp(openDb, created.id), { values: { name: 'nope' } });
    expect(answer(g)).toEqual(answer(gUuid));
    expect(g.statusCode).toBeGreaterThanOrEqual(400);

    expect((await call(app, bob.token, 'DELETE', rp(openDb, n))).statusCode).toBeLessThan(300);
    // trashed: the same record is still addressable for restore by its number, exactly as by uuid
    const restored = await call(app, bob.token, 'POST', rp(openDb, n, '/restore'));
    expect(restored.statusCode).toBeLessThan(300);
    expect((await call(app, bob.token, 'GET', rp(openDb, created.id))).statusCode).toBe(200);
  });
});
