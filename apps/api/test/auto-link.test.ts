import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-085: auto-link records by matching field-to-field conditions.
 * Clients.email == Contacts.email links the two, run-now and on-write.
 */
let app: NestFastifyApplication;
let owner: { token: string; id: string };
let ws: string;
let clients: string;
let contacts: string;
let relationId: string;
let clientFieldA: string; // relation field on Clients (points at Contacts)
let clientEmailApi: string;
let contactEmailApi: string;

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

async function addField(db: string, name: string): Promise<{ id: string; apiName: string }> {
  const res = await inject('POST', `/workspaces/${ws}/databases/${db}/fields`, {
    display_name: name,
    type: 'email',
  });
  expect(res.statusCode, `add field ${name}`).toBe(201);
  return res.json();
}

async function addRecord(db: string, emailApi: string, email: string): Promise<string> {
  const res = await inject('POST', `/workspaces/${ws}/databases/${db}/records`, {
    values: { [emailApi]: email },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function linksFor(db: string, rec: string, field: string): Promise<string[]> {
  const res = await inject('GET', `/workspaces/${ws}/databases/${db}/records/${rec}/links/${field}`);
  expect(res.statusCode).toBe(200);
  return res.json().data.map((r: { id: string }) => r.id);
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  ws = (await inject('POST', '/workspaces', { name: 'Auto WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  clients = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Clients' })).json().id;
  contacts = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Contacts' })).json().id;

  clientEmailApi = (await addField(clients, 'Email')).apiName;
  contactEmailApi = (await addField(contacts, 'Email')).apiName;

  const rel = (
    await inject('POST', '/workspaces/' + ws + '/relations', {
      database_a_id: clients,
      database_b_id: contacts,
      cardinality: 'many_to_many',
    })
  ).json();
  relationId = rel.id;
  clientFieldA = rel.field_a.id;
});

afterAll(async () => {
  await app.close();
});

describe('auto-link config (MN-085)', () => {
  it('sets rules referencing fields by api_name and echoes comparable fields', async () => {
    const res = await inject('PATCH', `/workspaces/${ws}/relations/${relationId}`, {
      auto_link: {
        conditions: [{ field_a: clientEmailApi, field_b: contactEmailApi }],
        case_sensitive: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.auto_link.conditions).toHaveLength(1);
    // resolved to field ids on save
    expect(body.auto_link.conditions[0].field_a_id).toBeTruthy();
    expect(body.comparable_fields_a.some((f: { api_name: string }) => f.api_name === clientEmailApi)).toBe(true);
  });

  it('rejects a non-comparable field with a helpful message', async () => {
    const sel = await inject('POST', `/workspaces/${ws}/databases/${clients}/fields`, {
      display_name: 'Stage',
      type: 'select',
      options: [{ label: 'New' }],
    });
    const res = await inject('PATCH', `/workspaces/${ws}/relations/${relationId}`, {
      auto_link: { conditions: [{ field_a: sel.json().apiName, field_b: contactEmailApi }], case_sensitive: false },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error?.message ?? res.json().message).toMatch(/can't be matched/);
  });
});

describe('run auto-link now (MN-085)', () => {
  it('links matches, reports ambiguous/unmatched, and is idempotent', async () => {
    // Disable rules while seeding so the on-write subscriber doesn't pre-link them —
    // this isolates the run-now backfill path.
    await inject('PATCH', `/workspaces/${ws}/relations/${relationId}`, { auto_link: null });
    const c1 = await addRecord(clients, clientEmailApi, 'match@x.com');
    await addRecord(clients, clientEmailApi, 'lonely@x.com'); // unmatched
    const k1 = await addRecord(contacts, contactEmailApi, 'MATCH@X.com'); // case-insensitive match to c1
    // Now enable rules and backfill existing records.
    await inject('PATCH', `/workspaces/${ws}/relations/${relationId}`, {
      auto_link: { conditions: [{ field_a: clientEmailApi, field_b: contactEmailApi }], case_sensitive: false },
    });

    const run = await inject('POST', `/workspaces/${ws}/relations/${relationId}/auto-link`);
    expect(run.statusCode).toBe(201);
    const summary = run.json();
    expect(summary.created).toBe(1);
    expect(summary.matched).toBe(1);
    expect(summary.unmatched).toBeGreaterThanOrEqual(1);

    expect(await linksFor(clients, c1, clientFieldA)).toContain(k1);

    // Re-running creates nothing new.
    const again = await inject('POST', `/workspaces/${ws}/relations/${relationId}/auto-link`);
    expect(again.json().created).toBe(0);
  });
});

describe('on-write auto-link (MN-085)', () => {
  it('links a newly created record whose match field matches an existing one', async () => {
    const k2 = await addRecord(contacts, contactEmailApi, 'fresh@x.com');
    const c3 = await addRecord(clients, clientEmailApi, 'fresh@x.com'); // triggers on-write subscriber

    // The subscriber runs off the after-commit event (async); poll briefly.
    let linked: string[] = [];
    for (let i = 0; i < 20 && !linked.includes(k2); i++) {
      linked = await linksFor(clients, c3, clientFieldA);
      if (!linked.includes(k2)) await new Promise((r) => setTimeout(r, 50));
    }
    expect(linked).toContain(k2);
  });
});
