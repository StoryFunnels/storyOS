import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let projectsId: string;
let clientsId: string;
let clientFieldId: string; // relation field on Projects (one_to_many, side a)
let tagFieldApi: string;
let emailFieldApi: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'LookupFan');
  wsId = (await inject('POST', '/workspaces', { name: 'Lookup WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  projectsId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  clientsId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;

  const email = await inject('POST', `/workspaces/${wsId}/databases/${clientsId}/fields`, {
    display_name: 'Contact Email', type: 'email', config: {},
  });
  emailFieldApi = email.json().apiName;
  const tag = await inject('POST', `/workspaces/${wsId}/databases/${clientsId}/fields`, {
    display_name: 'Tier', type: 'select', config: {}, options: [{ label: 'Gold' }, { label: 'Silver' }],
  });
  tagFieldApi = tag.json().apiName;

  const relation = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsId, database_b_id: clientsId, cardinality: 'one_to_many', field_a_name: 'Client',
  });
  clientFieldId = relation.json().field_a.id;
});

afterAll(async () => {
  await app.close();
});

describe('lookup fields (MN-040)', () => {
  let lookupApi: string;
  let clientRecId: string;
  let projectRecId: string;

  it('creates a lookup and rejects invalid configs', async () => {
    const bad1 = await inject('POST', `/workspaces/${wsId}/databases/${projectsId}/fields`, {
      display_name: 'Broken', type: 'lookup', config: { relation_field_id: crypto.randomUUID(), target_field_api_name: emailFieldApi },
    });
    expect(bad1.statusCode).toBe(422);
    const bad2 = await inject('POST', `/workspaces/${wsId}/databases/${projectsId}/fields`, {
      display_name: 'Broken 2', type: 'lookup', config: { relation_field_id: clientFieldId, target_field_api_name: 'nope' },
    });
    expect(bad2.statusCode).toBe(422);

    const ok = await inject('POST', `/workspaces/${wsId}/databases/${projectsId}/fields`, {
      display_name: 'Client Email', type: 'lookup',
      config: { relation_field_id: clientFieldId, target_field_api_name: emailFieldApi },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    lookupApi = ok.json().apiName;
  });

  it('resolves scalar values through one_to_many and updates live', async () => {
    const tierId = (await inject('GET', `/workspaces/${wsId}/databases/${clientsId}`)).json()
      .fields.find((f: { apiName: string }) => f.apiName === tagFieldApi)
      .options.find((o: { label: string }) => o.label === 'Gold').id;
    clientRecId = (await inject('POST', `/workspaces/${wsId}/databases/${clientsId}/records`, {
      values: { name: 'Globex', [emailFieldApi]: 'ceo@globex.com', [tagFieldApi]: tierId },
    })).json().id;
    projectRecId = (await inject('POST', `/workspaces/${wsId}/databases/${projectsId}/records`, {
      values: { name: 'Rebrand' },
    })).json().id;
    await inject('PUT', `/workspaces/${wsId}/databases/${projectsId}/records/${projectRecId}/links/${clientFieldId}`, {
      record_ids: [clientRecId],
    });

    const rec = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}/records/${projectRecId}`)).json();
    expect(rec.values[lookupApi]).toBe('ceo@globex.com');

    // Live: change the source, lookup follows.
    await inject('PATCH', `/workspaces/${wsId}/databases/${clientsId}/records/${clientRecId}`, {
      values: { [emailFieldApi]: 'new@globex.com' },
    });
    const rec2 = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}/records/${projectRecId}`)).json();
    expect(rec2.values[lookupApi]).toBe('new@globex.com');
  });

  it('projects select targets as labels', async () => {
    const tier = await inject('POST', `/workspaces/${wsId}/databases/${projectsId}/fields`, {
      display_name: 'Client Tier', type: 'lookup',
      config: { relation_field_id: clientFieldId, target_field_api_name: tagFieldApi },
    });
    const tierApi = tier.json().apiName;
    const rec = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}/records/${projectRecId}`)).json();
    expect(rec.values[tierApi]).toBe('Gold');
  });

  it('rejects writes to lookup values', async () => {
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${projectsId}/records/${projectRecId}`, {
      values: { [lookupApi]: 'hax@evil.com' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('deleting the target field removes dependent lookups', async () => {
    const emailFieldId = (await inject('GET', `/workspaces/${wsId}/databases/${clientsId}`)).json()
      .fields.find((f: { apiName: string }) => f.apiName === emailFieldApi).id;
    const del = await inject('DELETE', `/workspaces/${wsId}/databases/${clientsId}/fields/${emailFieldId}`);
    expect(del.json().lookups_removed).toBe(1);
    const projFields = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json().fields;
    expect(projFields.some((f: { apiName: string }) => f.apiName === lookupApi)).toBe(false);
  });

  it('severing the relation removes remaining lookups', async () => {
    const relations = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json().fields
      .filter((f: { type: string }) => f.type === 'relation');
    const relId = relations[0].relation.id;
    const del = await inject('DELETE', `/workspaces/${wsId}/relations/${relId}`, { confirm: true });
    expect(del.statusCode, del.body).toBe(200);
    const projFields = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json().fields;
    expect(projFields.some((f: { type: string }) => f.type === 'lookup')).toBe(false);
  });
});
