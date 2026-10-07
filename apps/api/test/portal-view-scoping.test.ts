import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #535 — recipient-scoped rows on a published view. THIS IS A SECURITY
 * BOUNDARY (the ticket's own words) and we have already failed this exact
 * test once: #469 was a guest reading titles of records in a denied database
 * through relation fields — the row filter was right and relation traversal
 * leaked around it. #495 tried to patch that client-side and was closed Will
 * Not Do. So every test here asserts against the RAW response body/status,
 * never against a client-side interpretation of it.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let spaceId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}
/** Unauthenticated request — the public portal path. */
async function pub(url: string) {
  return app.inject({ method: 'GET', url: `/api/v1${url}` });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PortalScopeOwner');
  wsId = (await as('POST', '/workspaces', { name: '535 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

/** A database with a text `Owner Email` field, N records tagged to different owners. */
async function makeScopedDb(name: string) {
  const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json().id;
  const ownerField = (
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Owner Email', type: 'email' })
  ).json();
  return { dbId, ownerApiName: ownerField.apiName };
}

async function makeRecipient(label: string, email: string) {
  return (await as('POST', `/workspaces/${wsId}/portal-recipients`, { label, email })).json();
}

async function shareScoped(dbId: string, viewId: string, scopeApiName: string) {
  const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
    recipient_scope_field_api_name: scopeApiName,
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().token as string;
}

describe('#535 recipient-scoped rows — text/email match', () => {
  it('ADVERSARIAL: two recipients, overlapping-but-different row sets — each sees exactly their own, intersection empty both ways', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Text Scope Overlap');
    const recA = await makeRecipient('Client A', 'a@clients.test');
    const recB = await makeRecipient('Client B', 'b@clients.test');

    const rowA1 = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'a@clients.test' } })).json();
    const rowA2 = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'a@clients.test' } })).json();
    const rowB1 = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'b@clients.test' } })).json();

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    const asA = await (await pub(`/public/views/${token}?recipient=${recA.token}`)).json();
    const asB = await (await pub(`/public/views/${token}?recipient=${recB.token}`)).json();

    const idsA = new Set(asA.records.data.map((r: { id: string }) => r.id));
    const idsB = new Set(asB.records.data.map((r: { id: string }) => r.id));

    expect(idsA).toEqual(new Set([rowA1.id, rowA2.id]));
    expect(idsB).toEqual(new Set([rowB1.id]));
    expect([...idsA].some((id) => idsB.has(id)), 'intersection must be empty A→B').toBe(false);
    expect([...idsB].some((id) => idsA.has(id)), 'intersection must be empty B→A').toBe(false);
    expect(JSON.stringify(asA), 'A must never see B row ids in the raw response').not.toContain(rowB1.id);
    expect(JSON.stringify(asB), 'B must never see A row ids in the raw response').not.toContain(rowA1.id);
  });

  it('ADVERSARIAL: a recipient cannot widen scope via query string, cursor tampering, or a foreign token — always own scope or 403/404', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Text Scope Tamper');
    const recA = await makeRecipient('Tamper A', 'tamperA@clients.test');
    const recB = await makeRecipient('Tamper B', 'tamperB@clients.test');
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'tamperA@clients.test' } });
    const rowB = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'tamperB@clients.test' } })).json();

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    // No recipient at all: fail closed, not 200-with-everything.
    const noRecipient = await pub(`/public/views/${token}`);
    expect(noRecipient.statusCode).toBe(403);

    // A garbage/foreign recipient token: rejected, not silently treated as "no scope".
    const garbage = await pub(`/public/views/${token}?recipient=not-a-real-token`);
    expect(garbage.statusCode).toBe(403);

    // An arbitrary/garbage cursor under A's own recipient token must never surface
    // B's row — the scope filter is ANDed server-side on every page regardless of
    // what the cursor decodes to (there is no caller-supplied filter/sort at all on
    // this endpoint, only `cursor`, so this is the entire tampering surface).
    const asAGarbageCursor = await (
      await pub(`/public/views/${token}?recipient=${recA.token}&cursor=${encodeURIComponent(Buffer.from('not-a-real-date').toString('base64url'))}`)
    ).json();
    expect(JSON.stringify(asAGarbageCursor)).not.toContain(rowB.id);
  });

  it('fail closed: a recipient with no email cannot match a text/email scope rule — sees nothing, not everything', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Text Scope No Email');
    const noEmailRecipient = await makeRecipient('No Email Co', undefined as never);
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'someone@clients.test' } });

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = await shareScoped(dbId, viewId, ownerApiName);

    const res = await (await pub(`/public/views/${token}?recipient=${noEmailRecipient.token}`)).json();
    expect(res.records.data).toEqual([]);
  });
});

describe('#535, the #469-regression AC: relation/lookup/rollup exposure is suppressed outright while scoping is active', () => {
  it('a relation column, even if explicitly allowlisted, exposes no id/title/preview once a recipient-scope rule is active', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Regression Rel Source');
    const targetId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Regression Rel Target' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: targetId,
      cardinality: 'one_to_many',
      field_a_name: 'Linked',
    });
    const relField = rel.json().field_a;
    const targetRec = (
      await as('POST', `/workspaces/${wsId}/databases/${targetId}/records`, { values: { name: 'Must never leak title' } })
    ).json();
    const rec = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'reg@clients.test' } })
    ).json();
    await as('PUT', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/links/${relField.id}`, { record_ids: [targetRec.id] });

    const recipient = await makeRecipient('Regression Client', 'reg@clients.test');
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const relFieldApiName = dbDetail.fields.find((f: { id: string }) => f.id === relField.id).apiName;

    // Explicitly allowlist the relation, same as an ordinary #264 share — this is
    // the exact configuration that leaked in #469.
    const share = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
      include_relation_api_names: [relFieldApiName],
      recipient_scope_field_api_name: ownerApiName,
    });
    expect(share.statusCode, share.body).toBeLessThan(300);
    const token = share.json().token;

    const body = await (await pub(`/public/views/${token}?recipient=${recipient.token}`)).json();
    expect(JSON.stringify(body), 'the relation target title must not leak while scoping is active').not.toContain('Must never leak title');
    expect(JSON.stringify(body), 'the target record id must not leak either').not.toContain(targetRec.id);
    const publicRec = body.records.data.find((r: { id: string }) => r.id === rec.id);
    expect(publicRec.values[relFieldApiName]).toBeUndefined();
    expect(body.fields.some((f: { api_name: string }) => f.api_name === relFieldApiName)).toBe(false);
  });

  it('a rollup over an out-of-scope relation target is not exposed either, even explicitly allowlisted', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Regression Rollup Source');
    const targetId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Regression Rollup Target' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: targetId,
      cardinality: 'one_to_many',
      field_a_name: 'Items',
    });
    const relField = rel.json().field_a;
    const rollup = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Item Count',
        type: 'rollup',
        config: { relation_field_id: relField.id, op: 'count' },
      })
    ).json();
    const targetRec = (await as('POST', `/workspaces/${wsId}/databases/${targetId}/records`, { values: {} })).json();
    const rec = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'rollup@clients.test' } })
    ).json();
    await as('PUT', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/links/${relField.id}`, { record_ids: [targetRec.id] });

    const recipient = await makeRecipient('Rollup Client', 'rollup@clients.test');
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const share = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
      visible_field_api_names: [ownerApiName, rollup.apiName],
      recipient_scope_field_api_name: ownerApiName,
    });
    const token = share.json().token;

    const body = await (await pub(`/public/views/${token}?recipient=${recipient.token}`)).json();
    const publicRec = body.records.data.find((r: { id: string }) => r.id === rec.id);
    expect(publicRec.values[rollup.apiName], 'a rollup must never become an oracle over out-of-scope rows').toBeUndefined();
  });
});

describe('#535 relation-typed scope rule', () => {
  it('a relation-typed scope rule matches by the recipient\'s linked_record_id, fails closed with none set', async () => {
    const clientsDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
    const projectsDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: projectsDb,
      database_b_id: clientsDb,
      cardinality: 'one_to_many',
      field_a_name: 'Client',
    });
    const clientField = rel.json().field_a;

    const clientRowX = (await as('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Client X' } })).json();
    const clientRowY = (await as('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Client Y' } })).json();

    const projX = (await as('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: {} })).json();
    await as('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${projX.id}/links/${clientField.id}`, { record_ids: [clientRowX.id] });
    const projY = (await as('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: {} })).json();
    await as('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${projY.id}/links/${clientField.id}`, { record_ids: [clientRowY.id] });

    const recipientX = await as('POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Client X', linked_record_id: clientRowX.id });
    expect(recipientX.statusCode, recipientX.body).toBe(201);
    const noLinkRecipient = (await as('POST', `/workspaces/${wsId}/portal-recipients`, { label: 'Unlinked' })).json();

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${projectsDb}`)).json();
    const viewId = dbDetail.views[0].id;
    const clientFieldApiName = dbDetail.fields.find((f: { id: string }) => f.id === clientField.id).apiName;
    const share = await as('POST', `/workspaces/${wsId}/databases/${projectsDb}/views/${viewId}/share`, {
      recipient_scope_field_api_name: clientFieldApiName,
    });
    expect(share.statusCode, share.body).toBeLessThan(300);
    const token = share.json().token;

    const asX = await (await pub(`/public/views/${token}?recipient=${recipientX.json().token}`)).json();
    expect(asX.records.data.map((r: { id: string }) => r.id)).toEqual([projX.id]);
    expect(JSON.stringify(asX)).not.toContain(projY.id);

    const asUnlinked = await (await pub(`/public/views/${token}?recipient=${noLinkRecipient.token}`)).json();
    expect(asUnlinked.records.data, 'no linked_record_id must fail closed to nothing, not everything').toEqual([]);
  });
});

describe('#535 MUST KEEP WORKING', () => {
  it('an ordinary published view with no recipient scope (#264/#527) behaves exactly as before', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Ordinary Share' })).json().id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} });
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;

    // No `recipient` query param needed at all — unscoped views are untouched.
    const res = await pub(`/public/views/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().records.data.length).toBeGreaterThan(0);
  });

  it('the same view opened by a signed-in workspace member with full access is unfiltered — scoping applies to recipient resolution only', async () => {
    const { dbId, ownerApiName } = await makeScopedDb('Member Unaffected');
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'someone@clients.test' } });
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [ownerApiName]: 'someone.else@clients.test' } });
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
      recipient_scope_field_api_name: ownerApiName,
    });

    // The ADMIN's own signed-in read of the database — never routed through
    // the public/recipient-scoped path at all — sees every row regardless.
    const signedIn = await as('GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    expect(signedIn.json().data.length).toBe(2);
  });
});
