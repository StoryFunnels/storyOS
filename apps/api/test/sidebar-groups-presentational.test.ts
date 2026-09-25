/**
 * #742 S2 — adversarial guest fixture for the tripwire docs/architecture/
 * views-and-the-sidebar.md line 68 states: "do not introduce a fourth
 * container." Otto's ruling on #742: the sidebar's planned Groups tier
 * (spaces grouped for DISPLAY, above the Space→Folder→(Database|Document|
 * View) tree) is deferred to the LAST step of the redesign specifically
 * BECAUSE it stays presentational-only — the space remains the sole access
 * boundary. If Groups ever gained real access semantics, that ordering
 * decision is void.
 *
 * There is no "Groups" concept anywhere in this codebase yet (grepped: zero
 * hits outside Tailwind's `group`/`group-hover` utility classes) — so this
 * fixture cannot exercise a Groups feature directly. What it CAN do, and
 * what makes it a real regression guard rather than a placeholder: prove,
 * against the actual sidebar-reading endpoints (`GET .../spaces`,
 * `GET .../databases`) and a REAL scoped guest (never just a member sanity
 * check — the #690 lesson, see notify-access-check.test.ts's own header),
 * that visibility is governed ENTIRELY by grant-derived
 * `visibleSpaceIds`/`guestVisibility` (access.service.ts) — and that an
 * arbitrary "grouping" blob written into `workspaces.settings` (the free-form
 * jsonb bag a future Groups feature would most naturally persist into,
 * mirroring how `sample_record_ids` already lives there) is never consulted
 * to expand OR restrict that set.
 *
 * If a future Groups implementation wires visibility to `settings.groups` (or
 * any grouping construct) in either direction, this test starts failing
 * immediately — that is the tripwire "becoming checkable" Otto asked for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { workspaces } from '../src/db/schema';

const { db } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceA: string; // granted to the guest
let spaceB: string; // NOT granted — must stay invisible
let spaceC: string; // NOT granted — must stay invisible
let dbInA: string; // the guest's granted database, inside space A
let otherDbInA: string; // a second database in the SAME granted space, NOT granted directly —
// visible anyway because visibility is per-SPACE once a space is granted (this is the
// existing, correct behaviour; the adversarial claim below is only about spaces B/C).
let dbInB: string; // a database in an UNGRANTED space — must never leak, grouping or not.

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SidebarGroupsOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '742 S2 WS' })).json().id;

  async function makeSpace(name: string) {
    return (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name })).json().id;
  }
  async function makeDb(spaceId: string, name: string) {
    return (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json().id;
  }

  spaceA = await makeSpace('Space A');
  spaceB = await makeSpace('Space B');
  spaceC = await makeSpace('Space C');
  dbInA = await makeDb(spaceA, 'Granted DB');
  otherDbInA = await makeDb(spaceA, 'Other DB in A');
  dbInB = await makeDb(spaceB, 'DB in B');
});

afterAll(async () => {
  await app.close();
});

describe('#742 S2 — Groups (or any future sidebar grouping) confers no access', () => {
  it('a guest scoped to Space A sees only Space A — never B or C', async () => {
    const guest = await signUpUser(app, 'ScopedGuest');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ space_id: spaceA, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(guest.token, 'POST', '/invites/accept', { token });

    const spacesRes = await as(guest.token, 'GET', `/workspaces/${wsId}/spaces`);
    expect(spacesRes.statusCode).toBe(200);
    expect(spacesRes.json().map((s: { id: string }) => s.id)).toEqual([spaceA]);

    const dbsRes = await as(guest.token, 'GET', `/workspaces/${wsId}/databases`);
    expect(dbsRes.statusCode).toBe(200);
    const visibleDbIds = dbsRes.json().map((d: { id: string }) => d.id);
    // Correct EXISTING behaviour: granting the whole space makes every
    // database inside it visible — the space is the door, not each database.
    expect(visibleDbIds.sort()).toEqual([dbInA, otherDbInA].sort());
    expect(visibleDbIds).not.toContain(dbInB);
  });

  it('ADVERSARIAL: grouping Space A with B/C in workspace.settings never widens a guest\'s visibility', async () => {
    // Simulate the most natural place a future presentational Groups feature
    // would persist its definition — the same free-form jsonb bag
    // `sample_record_ids` already lives in (see onboarding.controller.ts).
    // A real Groups feature might name this key anything; the point is that
    // NO such blob is ever consulted by the access layer, so the exact shape
    // doesn't matter — this asserts the absence of a consumer, not one
    // specific key name.
    await db
      .update(workspaces)
      .set({
        settings: {
          sidebar_groups: [{ id: 'grp1', label: 'Everything', space_ids: [spaceA, spaceB, spaceC] }],
        },
      })
      .where(eq(workspaces.id, wsId));

    const guest2 = await signUpUser(app, 'ScopedGuestTwo');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest2.email,
      role: 'guest',
      grants: [{ space_id: spaceA, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(guest2.token, 'POST', '/invites/accept', { token });

    const spacesRes = await as(guest2.token, 'GET', `/workspaces/${wsId}/spaces`);
    expect(
      spacesRes.json().map((s: { id: string }) => s.id),
      'a workspace-level grouping blob must never expand a guest past their real grants',
    ).toEqual([spaceA]);

    const dbsRes = await as(guest2.token, 'GET', `/workspaces/${wsId}/databases`);
    const visibleDbIds2 = dbsRes.json().map((d: { id: string }) => d.id);
    expect(visibleDbIds2.sort()).toEqual([dbInA, otherDbInA].sort());
    expect(visibleDbIds2, 'the grouping blob names spaceB, but B\'s database must still never leak').not.toContain(dbInB);
  });

  it('ADVERSARIAL: an admin/member is unaffected either way — grouping never restricts full access', async () => {
    // The tripwire cuts both directions: a "fourth container" could also try
    // to RESTRICT what an unscoped admin/member sees (e.g. "only show spaces
    // in your assigned group"). Confirm the settings blob from the previous
    // test doesn't do that either.
    const spacesRes = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`);
    const ids = spacesRes.json().map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining([spaceA, spaceB, spaceC]));
  });

  it('MUST KEEP WORKING: a guest granted on the DATABASE directly (no space grant) still only sees that one database, groups blob notwithstanding', async () => {
    const dbGuest = await signUpUser(app, 'DbScopedGuest');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: dbGuest.email,
      role: 'guest',
      grants: [{ database_id: dbInB, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(dbGuest.token, 'POST', '/invites/accept', { token });

    // Database-level grant makes exactly that one database's SPACE visible
    // (visibleSpaceIds' "granted databases pull in their space" rule) — but
    // NOT space A or C, even though the settings blob groups all three
    // together.
    const spacesRes = await as(dbGuest.token, 'GET', `/workspaces/${wsId}/spaces`);
    expect(spacesRes.json().map((s: { id: string }) => s.id)).toEqual([spaceB]);

    const dbsRes = await as(dbGuest.token, 'GET', `/workspaces/${wsId}/databases`);
    expect(dbsRes.json().map((d: { id: string }) => d.id)).toEqual([dbInB]);
  });
});
