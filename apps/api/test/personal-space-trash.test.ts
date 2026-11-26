import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, type Person } from './helpers/members';

/**
 * Ticket #1220 — a deleted personal space is as private as a live one (personal-space.md: private from admins too). The
 * admin-only space trash lists only shared spaces plus the caller's OWN personal space, and restoring someone else's personal
 * space answers exactly what a space that was never trashed answers. The member half (views trash) is pinned in
 * personal-view-privacy.test.ts; the guest rows here prove the admin gate still holds for the lowest role.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let adminId: string;
let ws: string;
let secondAdmin: Person;
let member: Person;
let guest: Person;
let sharedDb: string;

const fx = async (token: string, method: string, url: string, payload?: unknown) => {
  const r = await call(app, token, method, url, payload);
  if (r.statusCode >= 300) throw new Error(`fixture ${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const trash = async (token: string) => fx(token, 'GET', `/workspaces/${ws}/spaces/trash`);

/** Create the caller's personal space, put a personal view in it, then delete the space. */
async function trashedPersonalSpace(token: string): Promise<string> {
  const space = await fx(token, 'POST', `/workspaces/${ws}/spaces/personal`);
  await fx(token, 'DELETE', `/workspaces/${ws}/spaces/${space.id}`);
  return space.id;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Trash Admin');
  ws = (await fx(admin.token, 'POST', '/workspaces', { name: 'Trash WS' })).id;
  adminId = (await fx(admin.token, 'GET', '/me')).id;
  const space = (await fx(admin.token, 'GET', `/workspaces/${ws}/spaces`))[0].id;
  sharedDb = (await fx(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Shared DB' })).id;
  secondAdmin = await joinAs(app, admin.token, ws, 'Second Trash Admin', 'admin');
  member = await joinAs(app, admin.token, ws, 'Trash Member', 'member');
  guest = await joinAs(app, admin.token, ws, 'Trash Guest', 'guest', [{ database_id: sharedDb, role: 'viewer' }]);
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe("#1220 another member's deleted personal space is invisible in the trash and cannot be restored by an admin", () => {
  let memberSpace: string;
  let sharedSpace: string;
  beforeAll(async () => {
    memberSpace = await trashedPersonalSpace(member.token);
    sharedSpace = (await fx(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Shared and gone' })).id;
    await fx(admin.token, 'DELETE', `/workspaces/${ws}/spaces/${sharedSpace}`);
  });

  it.each([
    ['the workspace owner', () => admin.token],
    ['a second admin', () => secondAdmin.token],
  ])('%s does not see it in the space trash, but still sees shared spaces', async (_who, token) => {
    const listed = ids(await trash(token()));
    expect(listed).not.toContain(memberSpace);
    expect(listed).toContain(sharedSpace);
  });

  it('restoring it as an admin is the same 404 as an id that never existed, and changes nothing', async () => {
    const real = await call(app, secondAdmin.token, 'POST', `/workspaces/${ws}/spaces/${memberSpace}/restore`);
    const absent = await call(app, secondAdmin.token, 'POST', `/workspaces/${ws}/spaces/00000000-0000-4000-8000-000000000000/restore`);
    expect(real.statusCode, real.body).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(real.json().message).toBe(absent.json().message);
    // still deleted: the owner's own space list does not have it back
    const mine = await fx(member.token, 'GET', `/workspaces/${ws}/spaces`);
    expect(ids(mine)).not.toContain(memberSpace);
  });

  it('a shared deleted space is still restorable by an admin', async () => {
    const res = await call(app, secondAdmin.token, 'POST', `/workspaces/${ws}/spaces/${sharedSpace}/restore`);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a plain member and a guest stay refused by the admin gate', async () => {
    for (const p of [member, guest]) {
      expect((await call(app, p.token, 'GET', `/workspaces/${ws}/spaces/trash`)).statusCode).toBe(403);
      expect((await call(app, p.token, 'POST', `/workspaces/${ws}/spaces/${memberSpace}/restore`)).statusCode).toBe(403);
    }
  });
});

describe('#1220 an admin still sees and restores their OWN deleted personal space', () => {
  it('lists it for the owner only, and the owner can restore it', async () => {
    const mine = await trashedPersonalSpace(secondAdmin.token);
    expect(ids(await trash(secondAdmin.token))).toContain(mine);
    expect(ids(await trash(admin.token))).not.toContain(mine);
    expect((await call(app, admin.token, 'POST', `/workspaces/${ws}/spaces/${mine}/restore`)).statusCode).toBe(404);
    const res = await call(app, secondAdmin.token, 'POST', `/workspaces/${ws}/spaces/${mine}/restore`);
    expect(res.statusCode, res.body).toBe(201);
    expect(ids(await fx(secondAdmin.token, 'GET', `/workspaces/${ws}/spaces`))).toContain(mine);
    void adminId;
  });
});
