import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser, authed } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';

/**
 * #946 / ADR-0018 decision 6 — the workspace export carries `restricted` (spaces and databases) and the access grants, so a backup
 * never describes a confidential database as open. There is NO importer in this repo (docs/architecture/workspace-export.md:
 * "no importer yet"), so the round trip is done the way any importer must do it: read the zip, recreate the structure through the
 * public API, apply `restricted` and the grants from the zip, and check who can see what afterwards.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, general: string, back: string, tasks: string, payroll: string, hiring: string;
let alice: Person, bob: Person;
const SECRET = 'CEO salary 900k';
const adm = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

async function exportZip(workspaceId: string): Promise<AdmZip> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/export/workspace.zip`, headers: authed(owner.token) });
  expect(res.statusCode).toBe(200);
  return new AdmZip(res.rawPayload);
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'EX Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Export Restricted' })).json().id;
  general = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  back = (await adm('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
  const mk = async (space: string, name: string) => (await adm('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  tasks = await mk(general, 'Tasks');
  payroll = await mk(general, 'Payroll');
  hiring = await mk(back, 'Hiring');
  await adm('POST', `/workspaces/${ws}/databases/${payroll}/records`, { values: { name: SECRET } });
  alice = await joinAs(app, owner.token, ws, 'EX Alice', 'member');
  bob = await joinAs(app, owner.token, ws, 'EX Bob', 'member');
  await setRestricted(app, owner.token, ws, 'database', payroll);
  await setRestricted(app, owner.token, ws, 'space', back);
  await grant(app, owner.token, ws, alice.id, { database_id: payroll }, 'viewer');
  await grant(app, owner.token, ws, alice.id, { space_id: back }, 'editor');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#946 the export zip says what is restricted and who holds grants', () => {
  it('manifest: every space and database carries an explicit `restricted`', async () => {
    const manifest = JSON.parse((await exportZip(ws)).readAsText('manifest.json'));
    expect(manifest.format_version).toBe(3);
    const spaces = manifest.spaces as Array<{ id: string; restricted: boolean; databases: Array<{ id: string; restricted: boolean }> }>;
    expect(spaces.find((s) => s.id === general)!.restricted).toBe(false);
    expect(spaces.find((s) => s.id === back)!.restricted, 'the restricted space is marked').toBe(true);
    const dbs = spaces.flatMap((s) => s.databases);
    expect(dbs.find((d) => d.id === payroll)!.restricted, 'Payroll is marked restricted').toBe(true);
    expect(dbs.find((d) => d.id === tasks)!.restricted).toBe(false);
  });

  it("the database file carries it too, so a database file read alone is not 'open'", async () => {
    const zip = new AdmZip((await app.inject({ method: 'GET', url: `/api/v1/workspaces/${ws}/export/workspace.zip`, headers: authed(owner.token) })).rawPayload);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const entry = manifest.spaces.flatMap((s: { databases: Array<{ id: string; path: string }> }) => s.databases).find((d: { id: string }) => d.id === payroll);
    expect(JSON.parse(zip.readAsText(entry.path)).database.restricted).toBe(true);
  });

  it('access.json lists the grants (user, scope, role) and only for things that are in the export', async () => {
    const zip = await exportZip(ws);
    const access = JSON.parse(zip.readAsText('access.json')) as { grants: Array<{ user_id: string; space_id: string | null; database_id: string | null; record_id: string | null; role: string }> };
    const aliceGrants = access.grants.filter((g) => g.user_id === alice.id).map((g) => `${g.space_id ? 'space' : g.database_id ? 'database' : 'record'}:${g.space_id ?? g.database_id}:${g.role}`).sort();
    expect(aliceGrants).toEqual([`database:${payroll}:viewer`, `space:${back}:editor`].sort());
    expect(access.grants.some((g) => g.user_id === bob.id), 'bob holds none').toBe(false);
    expect(JSON.stringify(access), 'no emails or tokens in the access file').not.toMatch(/@|token/i);
  });

  it('a grant on a database that is NOT exported (the Members system database) is left out', async () => {
    const dbs = (await adm('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
    const members = dbs.find((d) => d.name === 'Members')!;
    await grant(app, owner.token, ws, bob.id, { database_id: members.id }, 'viewer');
    const access = JSON.parse((await exportZip(ws)).readAsText('access.json')) as { grants: Array<{ database_id: string | null }> };
    expect(access.grants.some((g) => g.database_id === members.id), 'points at nothing a restore can rebuild').toBe(false);
    expect(access.grants.length).toBe(2);
  });

  it('an export with nothing restricted is unchanged except for explicit `restricted: false`', async () => {
    const o = await signUpUser(app, 'EX Plain Owner');
    const w = (await call(app, o.token, 'POST', '/workspaces', { name: 'Plain' })).json().id;
    const sp = (await call(app, o.token, 'GET', `/workspaces/${w}/spaces`)).json()[0].id;
    await call(app, o.token, 'POST', `/workspaces/${w}/databases`, { space_id: sp, name: 'Open' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${w}/export/workspace.zip`, headers: authed(o.token) });
    const zip = new AdmZip(res.rawPayload);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const all = [...manifest.spaces, ...manifest.spaces.flatMap((s: { databases: unknown[] }) => s.databases)] as Array<{ restricted: boolean }>;
    expect(all.every((x) => x.restricted === false)).toBe(true);
    expect(JSON.parse(zip.readAsText('access.json')).grants).toEqual([]);
  });
});

describe('#946 export-then-restore: restriction and grants survive; a member without a grant still gets 404', () => {
  it('replaying the zip into a fresh workspace through the public API reproduces who can see what', async () => {
    const zip = await exportZip(ws);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const access = JSON.parse(zip.readAsText('access.json')) as { grants: Array<{ user_id: string; space_id: string | null; database_id: string | null; role: string }> };

    // The importer's job: recreate the structure, then apply `restricted` and the grants from the zip.
    const ws2 = (await adm('POST', '/workspaces', { name: 'Restored' })).json().id;
    for (const p of [alice, bob]) {
      const inv = await adm('POST', `/workspaces/${ws2}/invites`, { email: p.email, role: 'member' });
      expect((await call(app, p.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! })).statusCode).toBe(201);
    }
    const idMap = new Map<string, string>();
    const defaultSpace = (await adm('GET', `/workspaces/${ws2}/spaces`)).json()[0].id as string;
    for (const s of manifest.spaces as Array<{ id: string; name: string; restricted: boolean; databases: Array<{ id: string; name: string; restricted: boolean }> }>) {
      const sid = s.id === general ? defaultSpace : ((await adm('POST', `/workspaces/${ws2}/spaces`, { name: s.name })).json().id as string);
      idMap.set(s.id, sid);
      for (const d of s.databases) {
        const did = (await adm('POST', `/workspaces/${ws2}/databases`, { space_id: sid, name: d.name })).json().id as string;
        idMap.set(d.id, did);
        if (d.restricted) await setRestricted(app, owner.token, ws2, 'database', did);
      }
      if (s.restricted) await setRestricted(app, owner.token, ws2, 'space', sid);
    }
    for (const g of access.grants) {
      const scope = g.space_id ? { space_id: idMap.get(g.space_id)! } : { database_id: idMap.get(g.database_id!)! };
      await grant(app, owner.token, ws2, g.user_id, scope, g.role);
    }

    const payroll2 = idMap.get(payroll)!;
    expect((await call(app, bob.token, 'GET', `/workspaces/${ws2}/databases/${payroll2}`)).statusCode, 'bob has no grant: 404 after the restore').toBe(404);
    expect((await call(app, alice.token, 'GET', `/workspaces/${ws2}/databases/${payroll2}`)).json().my_access).toBe('viewer');
    expect((await call(app, bob.token, 'GET', `/workspaces/${ws2}/databases/${idMap.get(hiring)!}`)).statusCode).toBe(404);
  });
});
