/**
 * #458 — `/records/{rec}/links/{field}` and `/records/{rec}/buttons/{field}`
 * accept a field's api_name, and never answer 5xx for one they don't know.
 *
 * The bug: the path segment went straight into `eq(fields.id, …)` against a
 * `uuid` column, so anything that wasn't a UUID made Postgres raise 22P02 and
 * the exception escaped as a 500. The `NotFoundException` on the next line was
 * correct and simply unreachable — which is why a well-formed-but-unknown UUID
 * answered 404 and an api_name did not.
 *
 * That made the links routes the only record surface demanding a UUID, with no
 * signal that they did: a caller who has just written a query filter saying
 * `{"field":"agents"}` writes `agents` here and is told the server is broken.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let clientsDb: string;
let projectsDb: string;
let otherDb: string;
let clientFieldId: string;
let clientApiName: string;
let otherRelationFieldId: string;
let acme: string;
let siteRedesign: string;
/** A relation field whose api_name is deliberately not a UUID-shaped string. */
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Linker458');
  wsId = (await inject('POST', '/workspaces', { name: 'Links WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  clientsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients458' })).json().id;
  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects458' })).json().id;
  otherDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Elsewhere458' })).json().id;

  const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsDb,
    database_b_id: clientsDb,
    cardinality: 'many_to_many',
    field_a_name: 'Client',
    field_b_name: 'Projects',
  })).json();
  clientFieldId = rel.field_a.id;
  clientApiName = rel.field_a.api_name;

  // A relation field that exists, but on a database the caller is not addressing.
  const otherRel = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: otherDb,
    database_b_id: clientsDb,
    cardinality: 'many_to_many',
    field_a_name: 'Owner',
    field_b_name: 'Owned',
  })).json();
  otherRelationFieldId = otherRel.field_a.id;

  // A non-relation field, to prove "exists but is the wrong kind" is a 404 too.
  await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
    display_name: 'State',
    type: 'select',
    config: {},
    options: [{ label: 'Open' }],
  });

  acme = (await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Acme458' } })).json().id;
  siteRedesign = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Redesign458' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

const linksUrl = (field: string) =>
  `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${field}`;

describe('#458 — a field api_name on the links routes', () => {
  it('GET by api_name returns exactly what GET by uuid returns', async () => {
    // Link something first, so "identical" is a claim about real data rather
    // than about two empty lists.
    const add = await inject('POST', linksUrl(clientFieldId), { record_ids: [acme] });
    expect(add.statusCode, add.body).toBeLessThan(300);

    const byUuid = await inject('GET', linksUrl(clientFieldId));
    const byApiName = await inject('GET', linksUrl(clientApiName));
    expect(byApiName.statusCode, byApiName.body).toBe(200);
    expect(byUuid.statusCode).toBe(200);
    expect(byApiName.json()).toEqual(byUuid.json());
    // MUST KEEP WORKING: the uuid form still returns {id, title, number} chips.
    const chips = byUuid.json().data ?? byUuid.json();
    expect(chips[0]).toMatchObject({ id: acme });
  });

  it('POST, PUT and DELETE all accept the api_name too', async () => {
    const put = await inject('PUT', linksUrl(clientApiName), { record_ids: [acme] });
    expect(put.statusCode, put.body).toBeLessThan(300);

    const del = await inject('DELETE', linksUrl(clientApiName), { record_ids: [acme] });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await inject('GET', linksUrl(clientApiName))).json().data ?? []).toHaveLength(0);

    const post = await inject('POST', linksUrl(clientApiName), { record_ids: [acme] });
    expect(post.statusCode, post.body).toBeLessThan(300);
    expect(((await inject('GET', linksUrl(clientFieldId))).json().data ?? [])).toHaveLength(1);
  });

  it('an unrecognised identifier is 4xx on every verb and in every form — never 5xx', async () => {
    // The four forms the ticket names. "nosuchfield" is the one that used to
    // reach Postgres as a uuid comparand and come back 500.
    const forms = [
      ['a non-uuid naming no field', 'nosuchfield'],
      ['a well-formed uuid naming no field', UNKNOWN_UUID],
      ['a field that exists but is not a relation', 'state'],
      ['a relation field on another database', otherRelationFieldId],
    ] as const;

    for (const [what, field] of forms) {
      for (const [method, payload] of [
        ['GET', undefined],
        ['POST', { record_ids: [acme] }],
        ['PUT', { record_ids: [acme] }],
        ['DELETE', { record_ids: [acme] }],
      ] as const) {
        const res = await inject(method, linksUrl(field), payload);
        expect(res.statusCode, `${method} with ${what}: ${res.body}`).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, `${method} with ${what} must not be a 5xx: ${res.body}`).toBeLessThan(500);
      }
    }
  });

  it('the sibling buttons route has the same shape, so it takes an api_name too (#458 AC5)', async () => {
    const button = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Ping',
      type: 'button',
      config: { actions: [{ type: 'set_values', values: { name: 'Pressed' } }] },
    })).json();
    const pressUrl = (field: string) =>
      `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/buttons/${field}/press`;

    const byApiName = await inject('POST', pressUrl(button.apiName));
    expect(byApiName.statusCode, byApiName.body).toBeLessThan(300);

    // And an identifier it does not know is a 4xx here too, not a 500.
    for (const field of ['nosuchbutton', UNKNOWN_UUID, 'state']) {
      const res = await inject('POST', pressUrl(field));
      expect(res.statusCode, `${field}: ${res.body}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `${field} must not be a 5xx: ${res.body}`).toBeLessThan(500);
    }
  });
});
