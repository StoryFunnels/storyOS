import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #37 — #453 made database/view/space deletion soft (storage-only); this
 * ticket is the missing restore path. Split cleanly from #454 (admin audit
 * log, different data) per the ticket's own "GROOMED" note.
 *
 * The load-bearing correctness rule, straight from softDeleteDatabaseCascade's
 * own doc comment: a database's cascade only touches fields/records/views
 * that were LIVE at delete time (deletedAt IS NULL guard) — so restore must
 * only bring back children whose deletedAt EXACTLY EQUALS the database's own,
 * never something independently trashed earlier (which keeps its own,
 * different timestamp) and never something genuinely hard-deleted (which no
 * longer exists to match anything).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;

function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RestoreAdmin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '37 WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

describe('#37 — restoring a deleted DATABASE brings back exactly what was cascade-deleted with it', () => {
  it('a restored database has its fields, records and views attached and reachable again', async () => {
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Restore Me' })).json().id;
    const field = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'text' })
    ).json();
    const rec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [field.apiName]: 'hello' } })
    ).json();
    const extraView = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
        name: 'Extra',
        type: 'table',
        config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
      })
    ).json();

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}`, { confirm: 'Restore Me' });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).statusCode).toBe(404);

    const trash = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/trash`);
    expect(trash.statusCode, trash.body).toBe(200);
    expect(trash.json().some((d: { id: string }) => d.id === dbId)).toBe(true);

    const restore = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/restore`);
    expect(restore.statusCode, restore.body).toBeLessThan(300);

    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().fields.some((f: { id: string }) => f.id === field.id)).toBe(true);
    expect(detail.json().views.some((v: { id: string }) => v.id === extraView.id)).toBe(true);

    const restoredRecord = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`);
    expect(restoredRecord.statusCode, restoredRecord.body).toBe(200);
    expect(restoredRecord.json().values[field.apiName]).toBe('hello');

    // MUST KEEP WORKING: appears exactly once in the normal list, not twice.
    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/databases`);
    expect(list.json().filter((d: { id: string }) => d.id === dbId)).toHaveLength(1);

    // No longer in trash.
    const trashAfter = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/trash`);
    expect(trashAfter.json().some((d: { id: string }) => d.id === dbId)).toBe(false);
  });

  it('a record deleted BEFORE its database was deleted stays in trash — restoring the database does not resurrect it', async () => {
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Independent Trash' })).json().id;
    const early = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'trashed first' } })).json();
    const del1 = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${early.id}`);
    expect(del1.statusCode, del1.body).toBeLessThan(300);

    // A moment later, the whole database goes.
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}`, { confirm: 'Independent Trash' });
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/restore`);

    // The database is back, but the record trashed BEFORE it was deleted stays trashed.
    const gone = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${early.id}`);
    expect(gone.statusCode).toBe(404);
    const trash = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/trash`);
    expect(trash.json().data.some((r: { id: string }) => r.id === early.id)).toBe(true);
  });

  it('a non-admin member cannot restore a deleted database', async () => {
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Admin Only' })).json().id;
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}`, { confirm: 'Admin Only' });

    const member = await signUpUser(app, 'RestoreMember');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(member.token, 'POST', '/invites/accept', { token });

    const res = await as(member.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/restore`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);

    // Admin can, though — positive control.
    const asAdmin = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/restore`);
    expect(asAdmin.statusCode, asAdmin.body).toBeLessThan(300);
  });

  it('restoring does not un-sever relations that were explicitly severed at delete time', async () => {
    const aId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Sever A' })).json().id;
    const bId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Sever B' })).json().id;
    await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
      database_a_id: aId, database_b_id: bId, cardinality: 'one_to_many', field_a_name: 'Link',
    });

    const blocked = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${aId}`, { confirm: 'Sever A' });
    expect(blocked.statusCode).toBe(409);

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${aId}`, { confirm: 'Sever A', sever_relations: true });
    expect(del.statusCode, del.body).toBeLessThan(300);

    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${aId}/restore`);
    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${aId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    // The relation field is gone for good — severing hard-deletes it, restore cannot bring it back.
    expect(detail.json().fields.some((f: { displayName: string }) => f.displayName === 'Link')).toBe(false);
  });
});

describe('#37 — restoring a deleted SPACE cascades to its databases', () => {
  it('restores the space, its cascade-deleted databases, and their fields/records/views', async () => {
    const otherSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Doomed Space' })).json();
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: otherSpace.id, name: 'In Doomed Space' })).json().id;
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'survives' } })).json();

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/spaces/${otherSpace.id}`, { confirm: otherSpace.name });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).statusCode).toBe(404);

    const trash = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/trash`);
    expect(trash.statusCode, trash.body).toBe(200);
    expect(trash.json().some((s: { id: string }) => s.id === otherSpace.id)).toBe(true);

    const restore = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${otherSpace.id}/restore`);
    expect(restore.statusCode, restore.body).toBeLessThan(300);
    expect(restore.json().databases_restored).toBe(1);

    const spaces = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`);
    expect(spaces.json().some((s: { id: string }) => s.id === otherSpace.id)).toBe(true);
    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const restoredRecord = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`);
    expect(restoredRecord.statusCode).toBe(200);
  });

  it('a database independently deleted before its space stays deleted after the space is restored', async () => {
    const otherSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Partial Doom' })).json();
    const survivorId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: otherSpace.id, name: 'Was Already Gone' })).json().id;
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${survivorId}`, { confirm: 'Was Already Gone' });

    await as(admin.token, 'DELETE', `/workspaces/${wsId}/spaces/${otherSpace.id}`, { confirm: otherSpace.name });
    const restore = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${otherSpace.id}/restore`);
    expect(restore.json().databases_restored).toBe(0);

    expect((await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${survivorId}`)).statusCode).toBe(404);
    const dbTrash = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/trash`);
    expect(dbTrash.json().some((d: { id: string }) => d.id === survivorId)).toBe(true);
  });

  it('a non-admin member cannot restore a deleted space', async () => {
    const otherSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Admin Only Space' })).json();
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/spaces/${otherSpace.id}`, { confirm: otherSpace.name });

    const member = await signUpUser(app, 'RestoreSpaceMember');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(member.token, 'POST', '/invites/accept', { token });

    const res = await as(member.token, 'POST', `/workspaces/${wsId}/spaces/${otherSpace.id}/restore`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('#37 — restoring a deleted VIEW (deleted on its own, not via a database/space cascade)', () => {
  it('restores just that view, listed in trash before and gone from it after', async () => {
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'View Restore DB' })).json().id;
    const extra = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
        name: 'Doomed View',
        type: 'table',
        config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
      })
    ).json();

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${extra.id}`);
    expect(del.statusCode, del.body).toBeLessThan(300);

    const trash = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/trash`);
    expect(trash.statusCode, trash.body).toBe(200);
    expect(trash.json().some((v: { id: string }) => v.id === extra.id)).toBe(true);

    const restore = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views/${extra.id}/restore`);
    expect(restore.statusCode, restore.body).toBeLessThan(300);

    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(detail.json().views.some((v: { id: string }) => v.id === extra.id)).toBe(true);
    const trashAfter = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/trash`);
    expect(trashAfter.json().some((v: { id: string }) => v.id === extra.id)).toBe(false);
  });
});

describe('#37 MUST KEEP WORKING: soft delete/restore for records, fields, space documents and comments is unchanged', () => {
  it('record restore still works exactly as before', async () => {
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Record Restore Unaffected' })).json().id;
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'x' } })).json();
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`);
    const restore = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/restore`);
    expect(restore.statusCode, restore.body).toBeLessThan(300);
  });
});
