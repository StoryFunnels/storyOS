import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #562 — `GET /workspaces/:ws/databases` (DatabasesService.list()) was
 * visibility-scoped but computed no per-row `my_access` at all, unlike the
 * single-database `get()`. A write-access-only picker (#433's Copy-to
 * dialog) had no per-row signal to filter on client-side. Fixed via
 * `AccessService.effectiveForDatabases` — the SAME `EffectiveRole`
 * computation `get()` already does, batched into ONE grants fetch for the
 * whole list rather than one per row.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceAId: string;
let spaceBId: string;
let dbInSpaceAId: string;
let dbInSpaceBId: string;
let dbDirectGrantId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'DbListAccessAdmin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '562 WS' })).json().id;
  spaceAId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  spaceBId = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Space B' })).json().id;

  dbInSpaceAId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceAId, name: 'In Space A' })).json().id;
  dbInSpaceBId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceBId, name: 'In Space B' })).json().id;
  dbDirectGrantId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceBId, name: 'Direct Grant DB' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#562 — GET .../databases exposes my_access per row', () => {
  it('an admin sees my_access: "admin" on every row', async () => {
    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/databases`);
    expect(list.statusCode, list.body).toBe(200);
    const rows = list.json() as Array<{ id: string; my_access: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.my_access === 'admin')).toBe(true);
  });

  it('an ordinary member sees my_access: "creator" on every row (workspace-wide, ADR-0009)', async () => {
    const member = await signUpUser(app, 'DbListAccessMember');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(member.token, 'POST', '/invites/accept', { token });

    const list = await as(member.token, 'GET', `/workspaces/${wsId}/databases`);
    const rows = list.json() as Array<{ id: string; my_access: string }>;
    expect(rows.every((r) => r.my_access === 'creator')).toBe(true);
  });

  it('a guest with a space-level viewer grant and a database-level editor grant on ANOTHER db gets the right per-row rank, not one workspace-wide value — batched, not N+1', async () => {
    const guest = await signUpUser(app, 'DbListAccessGuest');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [
        { space_id: spaceBId, role: 'viewer' },
        { database_id: dbDirectGrantId, role: 'editor' },
      ],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(guest.token, 'POST', '/invites/accept', { token });

    const list = await as(guest.token, 'GET', `/workspaces/${wsId}/databases`);
    expect(list.statusCode, list.body).toBe(200);
    const rows = list.json() as Array<{ id: string; my_access: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r.my_access]));

    // Space A is invisible to this guest at all (no grant) — MUST KEEP WORKING:
    // the existing visibility filter, unaffected by adding my_access.
    expect(byId.has(dbInSpaceAId)).toBe(false);

    // Space B's viewer grant applies to every database IN that space...
    expect(byId.get(dbInSpaceBId)).toBe('viewer');
    // ...EXCEPT the one with its own higher database-level grant, which wins
    // (highest-rank-wins, same rule effectiveForDatabase itself applies).
    expect(byId.get(dbDirectGrantId)).toBe('editor');
  });

  it('MUST KEEP WORKING: existing callers of the list endpoint see every field they saw before, additively', async () => {
    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/databases`);
    const row = (list.json() as Array<Record<string, unknown>>)[0]!;
    for (const key of ['id', 'name', 'apiSlug', 'spaceId', 'spaceSlug', 'qualifiedSlug', 'position']) {
      expect(row, `missing pre-existing field "${key}"`).toHaveProperty(key);
    }
  });
});
