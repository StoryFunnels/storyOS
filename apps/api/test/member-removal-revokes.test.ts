import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted, type Person } from './helpers/members';

/**
 * Ticket #1052 item 8 — removing a member ends what they held in that workspace: their tokens (revoked) and their grants
 * (deleted, #945). Re-inviting the same person must not bring either back. Their tokens on OTHER workspaces are untouched.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let person: Person;
let ws: string;
let other: string;
let restrictedDb: string;

const fx = async (token: string, method: string, url: string, payload?: unknown) => {
  const r = await call(app, token, method, url, payload);
  if (r.statusCode >= 300) throw new Error(`fixture ${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const mint = async (token: string, workspace: string): Promise<string> =>
  (await fx(token, 'POST', '/me/tokens', { name: `pat-${workspace.slice(0, 8)}`, workspace_id: workspace, scope: 'read' })).token;
const membershipOf = async (workspace: string, userId: string): Promise<string> => {
  const body = await fx(owner.token, 'GET', `/workspaces/${workspace}/members`);
  const list = (Array.isArray(body) ? body : body.data) as Array<{ id: string; user_id?: string; userId?: string }>;
  return list.find((m) => (m.user_id ?? m.userId) === userId)!.id;
};
const invite = async (workspace: string, p: Person) => {
  const inv = await fx(owner.token, 'POST', `/workspaces/${workspace}/invites`, { email: p.email, role: 'member' });
  await fx(p.token, 'POST', '/invites/accept', { token: new URL(inv.accept_url).searchParams.get('token')! });
};

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Revoke Owner');
  ws = (await fx(owner.token, 'POST', '/workspaces', { name: 'Revoke WS' })).id;
  other = (await fx(owner.token, 'POST', '/workspaces', { name: 'Other WS' })).id;
  const space = (await fx(owner.token, 'GET', `/workspaces/${ws}/spaces`))[0].id;
  restrictedDb = (await fx(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Restricted DB' })).id;
  await setRestricted(app, owner.token, ws, 'database', restrictedDb);
  person = await joinAs(app, owner.token, ws, 'Revoke Member', 'member');
  await grant(app, owner.token, ws, person.id, { database_id: restrictedDb }, 'viewer');
  await invite(other, person);
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('#1052 (8) member removal revokes tokens; re-inviting revives nothing', () => {
  it('a PAT minted before removal stays dead after the person is re-invited, and the old grant is gone', async () => {
    const pat = await mint(person.token, ws);
    const patOther = await mint(person.token, other);
    const records = `/workspaces/${ws}/databases/${restrictedDb}/records`;
    expect((await call(app, pat, 'GET', records)).statusCode).toBe(200);

    await fx(owner.token, 'DELETE', `/workspaces/${ws}/members/${await membershipOf(ws, person.id)}`);
    await invite(ws, person);

    expect((await call(app, pat, 'GET', records)).statusCode).toBe(401);
    // The grant on the restricted database did not come back with the membership.
    expect([403, 404]).toContain((await call(app, person.token, 'GET', records)).statusCode);
    // A token on another workspace is not this removal's business.
    expect((await call(app, patOther, 'GET', `/workspaces/${other}/databases`)).statusCode).toBe(200);
  });

  it('only the removed workspace’s tokens are revoked', async () => {
    const list = await fx(person.token, 'GET', '/me/tokens');
    const rows = (Array.isArray(list) ? list : list.data) as Array<{ workspace_id?: string; workspaceId?: string }>;
    const wsOf = (t: { workspace_id?: string; workspaceId?: string }) => t.workspace_id ?? t.workspaceId;
    expect(rows.some((t) => wsOf(t) === other), JSON.stringify(rows[0])).toBe(true);
    expect(rows.some((t) => wsOf(t) === ws)).toBe(false);
  });
});
