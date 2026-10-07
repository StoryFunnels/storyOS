import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #662 — `user`/`created_by`/`updated_by` were already in the API's
 * SORTABLE_FIELD_TYPES, but `sortExpr()` returned the raw stored user id
 * (fieldExpr's default: records.values->>id, or the records.createdBy/
 * updatedBy column) rather than the person's NAME. Sorting "worked" in the
 * sense that it didn't 422 and produced *a* stable order, but that order was
 * alphabetical-by-uuid — not alphabetical by the name the UI shows, which is
 * what every direction label ("A → Z") already promised. Fixed by resolving
 * through a correlated subquery against the `user` table in sortExpr().
 */

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let assigneeApi: string;
// Deliberately NOT alphabetical by signup order or by id — only a real name
// sort produces "Ada, Ben, Cleo" from this.
let ada: { token: string; email: string; id: string };
let ben: { token: string; email: string; id: string };
let cleo: { token: string; email: string; id: string };

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? admin.token),
    payload: payload as never,
  });
}

async function sortedTitles(payload: Record<string, unknown>): Promise<string[]> {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.map((r: { title: string }) => r.title);
}

async function inviteMember(email: string): Promise<void> {
  const invite = await inject('POST', `/workspaces/${wsId}/invites`, { email, role: 'member' });
  expect(invite.statusCode, invite.body).toBe(201);
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  const memberToken = [ada, ben, cleo].find((u) => u?.email === email)?.token;
  await inject('POST', '/invites/accept', { token }, memberToken);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Owner');
  // Signed up in an order that would sort WRONG if the fix regressed to id order.
  cleo = { ...(await signUpUser(app, 'Cleo')), id: '' };
  ada = { ...(await signUpUser(app, 'Ada')), id: '' };
  ben = { ...(await signUpUser(app, 'Ben')), id: '' };
  cleo.id = (await inject('GET', '/me', undefined, cleo.token)).json().id;
  ada.id = (await inject('GET', '/me', undefined, ada.token)).json().id;
  ben.id = (await inject('GET', '/me', undefined, ben.token)).json().id;

  wsId = (await inject('POST', '/workspaces', { name: 'User Sort WS' })).json().id;
  await inviteMember(ada.email);
  await inviteMember(ben.email);
  await inviteMember(cleo.email);

  const space = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  const assigneeField = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Assignee', type: 'user' })
  ).json();
  assigneeApi = assigneeField.apiName;

  const batch = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
    records: [
      { values: { name: 'Task for Cleo', [assigneeApi]: cleo.id } },
      { values: { name: 'Task for Ada', [assigneeApi]: ada.id } },
      { values: { name: 'Task for Ben', [assigneeApi]: ben.id } },
      { values: { name: 'Unassigned task' } },
    ],
  });
  expect(batch.statusCode, batch.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('sorting by a `user` field orders by the assigned NAME (#662)', () => {
  it('ascending: alphabetical by name, not by id or signup order', async () => {
    const result = await sortedTitles({ sorts: [{ field: assigneeApi, direction: 'asc' }] });
    expect(result.slice(0, 3)).toEqual(['Task for Ada', 'Task for Ben', 'Task for Cleo']);
  });

  it('descending: reverse-alphabetical by name', async () => {
    const result = await sortedTitles({ sorts: [{ field: assigneeApi, direction: 'desc' }] });
    expect(result.slice(0, 3)).toEqual(['Task for Cleo', 'Task for Ben', 'Task for Ada']);
  });

  it('an unassigned record sorts per the whole-sort nulls placement, not scattered by id', async () => {
    const last = await sortedTitles({ sorts: [{ field: assigneeApi, direction: 'asc' }] });
    expect(last[3]).toBe('Unassigned task'); // NULLS LAST default

    const first = await sortedTitles({ sorts: [{ field: assigneeApi, direction: 'asc' }], nulls: 'first' });
    expect(first[0]).toBe('Unassigned task');
    expect(first.slice(1)).toEqual(['Task for Ada', 'Task for Ben', 'Task for Cleo']);
  });

  it('a MULTI user field is still refused (unchanged — this ticket only fixes the ORDER, not what is offered)', async () => {
    const multiField = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Watchers',
        type: 'user',
        config: { multi: true },
      })
    ).json();
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      sorts: [{ field: multiField.apiName, direction: 'asc' }],
    });
    expect(res.statusCode, res.body).toBe(422);
  });
});

describe('created_by/updated_by ALSO get the name fix (same sortExpr path, #662)', () => {
  it('created_by orders by the creator\'s name, not their id', async () => {
    // Cleo created the workspace's records above (admin did) — create one more
    // as Ada and Ben so all three names are present and out of id/creation order
    // relative to each other.
    const asAda = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${dbId}/records`,
      { values: { name: 'By Ada' } },
      ada.token,
    );
    expect(asAda.statusCode, asAda.body).toBe(201);
    const asBen = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${dbId}/records`,
      { values: { name: 'By Ben' } },
      ben.token,
    );
    expect(asBen.statusCode, asBen.body).toBe(201);
    const asCleo = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${dbId}/records`,
      { values: { name: 'By Cleo' } },
      cleo.token,
    );
    expect(asCleo.statusCode, asCleo.body).toBe(201);

    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      filter: { field: 'name', op: 'contains', value: 'By ' },
      sorts: [{ field: 'created_by', direction: 'asc' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.map((r: { title: string }) => r.title)).toEqual(['By Ada', 'By Ben', 'By Cleo']);
  });
});
