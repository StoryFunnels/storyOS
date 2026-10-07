import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #567 — `POST .../views/personal` only ever required VIEWER access to create
 * a personal view (#520), but `DELETE .../views/:view` required EDITOR for
 * every view, personal or shared, with no ownership bypass. A viewer-only
 * guest who made their own private lens could never remove it themselves —
 * they'd need an editor to do it for them, defeating the point of a view
 * that's private to begin with. Fixed in views.controller.ts/views.service.ts:
 * deleting your OWN personal view now needs only viewer, matching create.
 * Everything else (a shared view, or someone else's personal view) is
 * unchanged: editor.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let spaceId: string;
let dbId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function makeViewerGuest(name: string) {
  const guest = await signUpUser(app, name);
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ database_id: dbId, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
  return guest;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PersonalDeleteAdmin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '567 WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: '567 DB' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#567 — deleting a PERSONAL view matches the access level creating one required', () => {
  it('a viewer-only guest can create AND delete their own personal view, with no editor involved', async () => {
    const guest = await makeViewerGuest('ViewerCanDeleteOwn');

    const create = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views/personal`, {
      name: 'My Lens',
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    expect(create.statusCode, create.body).toBe(201);
    const viewId = create.json().id;

    // Before the fix this 403'd: viewer access, editor required.
    const del = await as(guest.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}`);
    expect(del.statusCode, del.body).toBeLessThan(300);

    // Gone: a second delete 404s.
    const again = await as(guest.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}`);
    expect(again.statusCode).toBe(404);
  });

  it('a viewer-only guest still cannot delete a SHARED view — unchanged, still needs editor', async () => {
    const guest = await makeViewerGuest('ViewerCannotDeleteShared');
    const dbDetail = await (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const sharedViewId = dbDetail.views.find((v: { ownerUserId?: string | null }) => !v.ownerUserId).id;

    const del = await as(guest.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${sharedViewId}`);
    expect(del.statusCode).toBeGreaterThanOrEqual(400);
    expect(del.statusCode).toBeLessThan(500);
  });

  it("a viewer-only guest cannot delete ANOTHER member's personal view either — the bypass is ownership-gated, not view-type-gated", async () => {
    const owner = await makeViewerGuest('PersonalOwnerX');
    const bystander = await makeViewerGuest('PersonalBystanderX');

    const create = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views/personal`, {
      name: "Owner's Lens",
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    const viewId = create.json().id;

    const del = await as(bystander.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}`);
    expect(del.statusCode).toBeGreaterThanOrEqual(400);
    expect(del.statusCode).toBeLessThan(500);
  });

  it('MUST KEEP WORKING: deleting a shared view as an editor is unchanged', async () => {
    const extra = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Extra Shared',
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    expect(extra.statusCode, extra.body).toBeLessThan(300);
    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${extra.json().id}`);
    expect(del.statusCode, del.body).toBeLessThan(300);
  });
});

describe("#567 — the \"keep at least one view\" guard counts only SHARED views", () => {
  it('deleting personal views down to zero never trips the guard, even with only one shared view left', async () => {
    const soloDb = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Solo Shared View DB' })
    ).json().id;
    // Exactly one shared view exists (the auto-created default) — add two
    // personal views and delete both; the guard must never fire for either,
    // since neither ever counted as "the" shared view this guard protects.
    const p1 = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${soloDb}/views/personal`, {
        name: 'P1',
        type: 'table',
        config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
      })
    ).json();
    const p2 = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${soloDb}/views/personal`, {
        name: 'P2',
        type: 'table',
        config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
      })
    ).json();

    const del1 = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${soloDb}/views/${p1.id}`);
    expect(del1.statusCode, del1.body).toBeLessThan(300);
    const del2 = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${soloDb}/views/${p2.id}`);
    expect(del2.statusCode, del2.body).toBeLessThan(300);

    // Now try to delete the LAST remaining shared view — THIS must 409.
    const dbDetail = await (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${soloDb}`)).json();
    const lastShared = dbDetail.views.find((v: { ownerUserId?: string | null }) => !v.ownerUserId);
    const del3 = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${soloDb}/views/${lastShared.id}`);
    expect(del3.statusCode, del3.body).toBe(409);
  });

  it('MUST KEEP WORKING: deleting a shared view while >1 shared views exist is unaffected by however many personal views also exist', async () => {
    const multiDb = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Multi Shared View DB' })
    ).json().id;
    const secondShared = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${multiDb}/views`, {
      name: 'Second Shared',
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${multiDb}/views/personal`, {
      name: 'Bystander Personal',
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${multiDb}/views/${secondShared.json().id}`);
    expect(del.statusCode, del.body).toBeLessThan(300);
  });
});
