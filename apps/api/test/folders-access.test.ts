import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Sidebar folders had no access check: the list had no role floor and no scope check, and create / rename / delete
 * only checked that the caller was a member. So (1) a guest could read the folder NAMES of a space they were never
 * granted, and (2) any member could read, create, rename and delete folders inside ANOTHER member's personal space,
 * which ticket #291 decided is private even from admins.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let guest: { token: string; email: string };
let alice: { token: string; email: string };
let bob: { token: string; email: string };
let ws: string;
let closedSpace: string;
let openSpace: string;
let alicePersonal: string;
let closedFolder: string;
let personalFolder: string;
const CLOSED = 'Layoffs plan';
const PRIVATE = 'My private reading list';

const inject = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

async function join(user: { token: string; email: string }, role: 'guest' | 'member', grants?: unknown[]) {
  const inv = await inject(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: user.email, role, ...(grants ? { grants } : {}) });
  expect(inv.statusCode, inv.body).toBe(201);
  const ok = await inject(user.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  expect(ok.statusCode, ok.body).toBe(201);
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Folder Owner');
  guest = await signUpUser(app, 'Folder Guest');
  alice = await signUpUser(app, 'Folder Alice');
  bob = await signUpUser(app, 'Folder Bob');
  ws = (await inject(owner.token, 'POST', '/workspaces', { name: 'Folder Access WS' })).json().id;
  closedSpace = (await inject(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  openSpace = (await inject(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Client space' })).json().id;
  closedFolder = (await inject(owner.token, 'POST', `/workspaces/${ws}/spaces/${closedSpace}/folders`, { name: CLOSED })).json().id;
  await join(guest, 'guest', [{ space_id: openSpace, role: 'viewer' }]);
  await join(alice, 'member');
  await join(bob, 'member');
  alicePersonal = (await inject(alice.token, 'POST', `/workspaces/${ws}/spaces/personal`)).json().id;
  personalFolder = (await inject(alice.token, 'POST', `/workspaces/${ws}/spaces/${alicePersonal}/folders`, { name: PRIVATE })).json().id;
}, 240_000);
afterAll(async () => { await app.close(); });

const list = (token: string, space: string) => inject(token, 'GET', `/workspaces/${ws}/spaces/${space}/folders`);

describe('a guest reads only the folders of a space they can reach', () => {
  it('a space the guest has no grant on answers 404 and names no folder', async () => {
    const res = await list(guest.token, closedSpace);
    expect(res.statusCode, `served: ${res.body}`).toBe(404);
    expect(res.body).not.toContain(CLOSED);
  });

  it('a guest cannot write folders (create, rename, delete) in the space they CAN read, nor in the closed one', async () => {
    for (const space of [openSpace, closedSpace]) {
      expect((await inject(guest.token, 'POST', `/workspaces/${ws}/spaces/${space}/folders`, { name: 'x' })).statusCode).toBeGreaterThanOrEqual(403);
    }
    const rename = await inject(guest.token, 'PATCH', `/workspaces/${ws}/folders/${closedFolder}`, { name: 'defaced' });
    expect(rename.statusCode, rename.body).toBeGreaterThanOrEqual(403);
    expect((await inject(guest.token, 'DELETE', `/workspaces/${ws}/folders/${closedFolder}`)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('MUST KEEP WORKING: the guest lists the folders of a space they hold a grant on', async () => {
    expect((await list(guest.token, openSpace)).statusCode).toBe(200);
  });
});

describe('another member\'s personal space is private: its folders too', () => {
  it('Bob cannot list Alice\'s personal-space folders (404, and the name is not served)', async () => {
    const res = await list(bob.token, alicePersonal);
    expect(res.statusCode, `served: ${res.body}`).toBe(404);
    expect(res.body).not.toContain(PRIVATE);
  });

  it('the OWNER of the space, and even an admin, are held to the same rule: only Alice sees her personal space (admins are NOT an exception, ticket #291)', async () => {
    expect((await list(owner.token, alicePersonal)).statusCode, 'admin').toBe(404);
  });

  it('Bob cannot create, rename or delete a folder in it', async () => {
    expect((await inject(bob.token, 'POST', `/workspaces/${ws}/spaces/${alicePersonal}/folders`, { name: 'planted' })).statusCode).toBe(404);
    const rename = await inject(bob.token, 'PATCH', `/workspaces/${ws}/folders/${personalFolder}`, { name: 'defaced' });
    expect(rename.statusCode, rename.body).toBe(404);
    expect((await inject(bob.token, 'DELETE', `/workspaces/${ws}/folders/${personalFolder}`)).statusCode).toBe(404);
    const after = await list(alice.token, alicePersonal);
    expect((after.json().data as Array<{ name: string }>).map((f) => f.name), 'nothing was changed').toEqual([PRIVATE]);
  });

  it('MUST KEEP WORKING: Alice manages folders in her own personal space; a member and an admin manage them in a shared space', async () => {
    expect((await list(alice.token, alicePersonal)).statusCode).toBe(200);
    const created = await inject(alice.token, 'POST', `/workspaces/${ws}/spaces/${alicePersonal}/folders`, { name: 'Second' });
    expect(created.statusCode, created.body).toBe(201);
    const shared = await inject(bob.token, 'POST', `/workspaces/${ws}/spaces/${closedSpace}/folders`, { name: 'Bob folder' });
    expect(shared.statusCode, shared.body).toBe(201);
    expect((await inject(bob.token, 'PATCH', `/workspaces/${ws}/folders/${shared.json().id}`, { name: 'Renamed' })).statusCode).toBe(200);
    expect((await inject(owner.token, 'DELETE', `/workspaces/${ws}/folders/${shared.json().id}`)).statusCode).toBe(200);
  });
});
