import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #538 — a form published inside a portal stamps submissions with the
 * resolving recipient server-side, and a recipient may only ever create or
 * edit records within their own scope. THIS IS A SECURITY BOUNDARY, same
 * posture as portal-view-scoping.test.ts (#535): every assertion here checks
 * the raw response/record, never a client-side interpretation of it.
 *
 * Kept to <=10 anonymous `POST /public/forms/:token` calls across this WHOLE
 * file: that endpoint is throttled at 10/60s (public-forms.controller.ts),
 * keyed by IP (ApiThrottlerGuard) — not per token — so every test in this
 * file shares ONE bucket for the file's run, not one bucket each.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let spaceId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}
/** Unauthenticated request — the public form path. */
async function pub(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PortalFormOwner');
  wsId = (await as('POST', '/workspaces', { name: '538 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

/**
 * Clients db + a Deliverables db with a single-valued relation "Client" back
 * to it, a writable "Note" text field, and an "Internal" text field the form
 * never exposes. Returns everything needed to publish a portal form on it.
 */
async function makeScopedForm(name: string, formToken: string) {
  const clientsDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `${name} Clients` })).json().id;
  const delivDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `${name} Deliverables` })).json().id;
  const rel = await as('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: delivDb,
    database_b_id: clientsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Client',
  });
  const clientFieldId = rel.json().field_a.id;
  const noteField = (
    await as('POST', `/workspaces/${wsId}/databases/${delivDb}/fields`, { display_name: 'Note', type: 'text' })
  ).json();
  const internalField = (
    await as('POST', `/workspaces/${wsId}/databases/${delivDb}/fields`, { display_name: 'Internal', type: 'text' })
  ).json();

  // #538's own memory lesson, confirmed again here: a relation creation
  // response does NOT echo the new field's apiName — re-fetch it from the
  // database detail, matching portal-view-scoping.test.ts's own pattern.
  const delivDetail = (await as('GET', `/workspaces/${wsId}/databases/${delivDb}`)).json();
  const clientApiName = delivDetail.fields.find((f: { id: string }) => f.id === clientFieldId).apiName;

  const view = await as('POST', `/workspaces/${wsId}/databases/${delivDb}/views`, {
    name: `Portal form ${formToken}`,
    type: 'form',
    config: {
      sorts: [],
      hidden_field_ids: [],
      card_field_ids: [],
      column_widths: {},
      form: {
        title: name,
        access: 'public',
        public_token: formToken,
        // The scope field IS exposed here deliberately — the adversarial
        // test below submits a foreign client id through it on purpose.
        fields: [{ field_id: clientFieldId }, { field_id: noteField.id }],
      },
    },
  });
  expect(view.statusCode, view.body).toBe(201);
  const viewId = view.json().id;

  const share = await as('POST', `/workspaces/${wsId}/databases/${delivDb}/views/${viewId}/share`, {
    recipient_scope_field_api_name: clientApiName,
  });
  expect(share.statusCode, share.body).toBeLessThan(300);
  // Fail loudly here, not three assertions later, if the scope rule didn't
  // actually take (this is exactly the bug this test file caught once).
  expect(share.json().token).toBeTruthy();

  const clientX = (await as('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Client X' } })).json();
  const clientY = (await as('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Client Y' } })).json();
  const recipientX = (
    await as('POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Client X', linked_record_id: clientX.id })
  ).json();
  const recipientY = (
    await as('POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Client Y', linked_record_id: clientY.id })
  ).json();

  return { delivDb, clientApiName, noteApiName: noteField.apiName, internalApiName: internalField.apiName, clientX, clientY, recipientX, recipientY };
}

async function getRecord(dbId: string, recordId: string) {
  return (await as('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`)).json();
}

describe('#538 portal form write-back', () => {
  it('REQUIRES a recipient token, and rejects a garbage one — no anonymous fallthrough on a portal-scoped form', async () => {
    await makeScopedForm('NoToken', 'tok-538-notoken');
    const noToken = await pub('POST', '/public/forms/tok-538-notoken', { values: {} });
    expect(noToken.statusCode, noToken.body).toBe(403);
    const garbage = await pub('POST', '/public/forms/tok-538-notoken', { values: {}, recipient: 'not-a-real-token' });
    expect(garbage.statusCode, garbage.body).toBe(403);
  });

  it('ADVERSARIAL: a submitted scope value is discarded and stamped/attributed instead — the recipient\'s own scope always wins', async () => {
    const { delivDb, clientApiName, noteApiName, clientX, clientY, recipientX } = await makeScopedForm('Stamp', 'tok-538-stamp');
    const res = await pub('POST', '/public/forms/tok-538-stamp', {
      values: { [clientApiName]: [clientY.id], [noteApiName]: 'hello from X' },
      recipient: recipientX.token,
    });
    expect(res.statusCode, res.body).toBe(201);
    const record = await getRecord(delivDb, res.json().id);
    const linkedIds = (record.values[clientApiName] as Array<{ id: string }>).map((r) => r.id);
    expect(linkedIds).toEqual([clientX.id]);
    expect(linkedIds).not.toContain(clientY.id);
    expect(record.values[noteApiName]).toBe('hello from X');

    // #537's own AC: the submission is attributed on the recipient activity
    // log — checked here, on the SAME submission, rather than spending a
    // separate throttled POST on it.
    const activity = await as('GET', `/workspaces/${wsId}/portal-activity?recipient=${recipientX.id}`);
    expect(activity.statusCode, activity.body).toBe(200);
    const entry = activity.json().data.find((e: { outcome: string; reason: string }) => e.outcome === 'served' && e.reason === 'portal form create');
    expect(entry).toBeTruthy();
  });

  it('ADVERSARIAL: an unexposed field named in the payload is never written, even under portal scope', async () => {
    const { delivDb, noteApiName, internalApiName, recipientX } = await makeScopedForm('Unexposed', 'tok-538-unexposed');
    const res = await pub('POST', '/public/forms/tok-538-unexposed', {
      values: { [noteApiName]: 'visible', [internalApiName]: 'sneaky write' },
      recipient: recipientX.token,
    });
    expect(res.statusCode, res.body).toBe(201);
    const record = await getRecord(delivDb, res.json().id);
    expect(record.values[internalApiName]).toBeFalsy();
  });

  it('a recipient can edit a record already in their own scope', async () => {
    const { delivDb, noteApiName, recipientX } = await makeScopedForm('EditOwn', 'tok-538-editown');
    const created = await pub('POST', '/public/forms/tok-538-editown', { values: { [noteApiName]: 'first' }, recipient: recipientX.token });
    expect(created.statusCode, created.body).toBe(201);
    const recordId = created.json().id;

    const edited = await pub('POST', '/public/forms/tok-538-editown', {
      values: { [noteApiName]: 'updated' },
      recipient: recipientX.token,
      record_id: recordId,
    });
    expect(edited.statusCode, edited.body).toBe(201);
    expect(edited.json().id).toBe(recordId);
    const record = await getRecord(delivDb, recordId);
    expect(record.values[noteApiName]).toBe('updated');
  });

  it('ADVERSARIAL: recipient A cannot edit a record scoped to recipient B — 404, not 403', async () => {
    const { noteApiName, recipientX, recipientY } = await makeScopedForm('CrossEdit', 'tok-538-crossedit');
    const createdByY = await pub('POST', '/public/forms/tok-538-crossedit', { values: { [noteApiName]: 'belongs to Y' }, recipient: recipientY.token });
    expect(createdByY.statusCode, createdByY.body).toBe(201);

    const attempt = await pub('POST', '/public/forms/tok-538-crossedit', {
      values: { [noteApiName]: 'stolen edit' },
      recipient: recipientX.token,
      record_id: createdByY.json().id,
    });
    expect(attempt.statusCode, attempt.body).toBe(404);
  });

  it('MUST KEEP WORKING: record_id on an ORDINARY (non-portal) public form is rejected, not a silent create or a generic write', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Ordinary Form DB' })).json().id;
    const dbDetail = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const nameFieldId = dbDetail.fields.find((f: { type: string }) => f.type === 'title').id;
    const view = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Ordinary form',
      type: 'form',
      config: {
        sorts: [],
        hidden_field_ids: [],
        card_field_ids: [],
        column_widths: {},
        form: { title: 'Ordinary', access: 'public', public_token: 'tok-538-ordinary', fields: [{ field_id: nameFieldId }] },
      },
    });
    expect(view.statusCode, view.body).toBe(201);

    // No portal scope at all — an ordinary create still works exactly as before.
    const created = await pub('POST', '/public/forms/tok-538-ordinary', { values: { name: 'plain submission' } });
    expect(created.statusCode, created.body).toBe(201);

    const rejected = await pub('POST', '/public/forms/tok-538-ordinary', { values: { name: 'x' }, record_id: created.json().id });
    expect(rejected.statusCode, rejected.body).toBe(422);
  });
});
