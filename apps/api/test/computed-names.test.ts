import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

/** A fresh database with a text `Code` field; returns its id + the title field id. */
async function makeDb(name: string): Promise<{ dbId: string; codeApi: string; titleFieldId: string }> {
  const dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Code', type: 'text', config: {} });
  const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  const titleFieldId = detail.fields.find((f: { type: string }) => f.type === 'title').id;
  return { dbId, codeApi: 'code', titleFieldId };
}

async function setComputed(dbId: string, titleFieldId: string, source: string) {
  return inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${titleFieldId}`, {
    config: { name_mode: 'computed', source },
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Namer');
  wsId = (await inject('POST', '/workspaces', { name: 'Names WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

describe('computed record names — own-record mode (MN-130)', () => {
  it('computes the title on create and treats a direct title write as read-only', async () => {
    const { dbId, titleFieldId } = await makeDb('Projects');
    const switched = await setComputed(dbId, titleFieldId, 'concat({Code}, "-", format({Number}))');
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json().config.name_mode).toBe('computed');
    expect(switched.json().config.result_type).toBe('text');

    // A caller-supplied `name` is ignored — the title is always derived.
    const created = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'I will be ignored', code: 'BBB' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const rec = created.json();
    expect(rec.title).toBe(`BBB-${rec.number}`);
  });

  it('recomputes the title on update when a referenced field changes', async () => {
    const { dbId, titleFieldId } = await makeDb('Updatables');
    await setComputed(dbId, titleFieldId, 'concat({Code}, "-", format({Number}))');
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { code: 'AAA' },
    })).json();
    expect(rec.title).toBe(`AAA-${rec.number}`);

    const updated = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { code: 'ZZZ' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const after = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)).json();
    expect(after.title).toBe(`ZZZ-${rec.number}`);
  });

  it('resolves {Number}/#id post-allocation on create', async () => {
    const { dbId, titleFieldId } = await makeDb('Hashed');
    await setComputed(dbId, titleFieldId, 'concat("#", format({Number}))');
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { code: 'x' },
    })).json();
    expect(typeof rec.number).toBe('number');
    expect(rec.title).toBe(`#${rec.number}`);
  });

  it('falls back to #<number> when the template result is empty', async () => {
    const { dbId, titleFieldId } = await makeDb('Fallbackers');
    // {Code} alone — an empty Code yields an empty template result.
    await setComputed(dbId, titleFieldId, '{Code}');
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: {},
    })).json();
    expect(rec.title).toBe(`#${rec.number}`);
  });

  it('backfills existing records when a database switches to computed', async () => {
    const { dbId, titleFieldId } = await makeDb('Backfillers');
    // Two records created BEFORE the switch, in classic freetext mode.
    const r1 = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Old One', code: 'ONE' },
    })).json();
    const r2 = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Old Two', code: 'TWO' },
    })).json();
    expect(r1.title).toBe('Old One');

    await setComputed(dbId, titleFieldId, 'concat({Code}, "-", format({Number}))');

    const a1 = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${r1.id}`)).json();
    const a2 = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${r2.id}`)).json();
    expect(a1.title).toBe(`ONE-${r1.number}`);
    expect(a2.title).toBe(`TWO-${r2.number}`);
  });

  it('rejects a self-referencing template (reuses the #129 cycle guard)', async () => {
    const { dbId, titleFieldId } = await makeDb('SelfRef');
    const res = await setComputed(dbId, titleFieldId, 'concat({Name}, "!")');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/reference its own field/i);
  });

  it('can switch back to freetext, restoring an editable title', async () => {
    const { dbId, titleFieldId } = await makeDb('Revertible');
    await setComputed(dbId, titleFieldId, 'concat({Code}, "-", format({Number}))');
    const computed = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { code: 'C' },
    })).json();
    expect(computed.title).toBe(`C-${computed.number}`);

    const reverted = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${titleFieldId}`, {
      config: { name_mode: 'freetext' },
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(reverted.json().config.name_mode).toBe('freetext');

    // Freetext again: a direct title write now sticks.
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Hand-typed' },
    })).json();
    expect(rec.title).toBe('Hand-typed');
  });
});

describe('computed record names — cross-record templates via lookup (#132)', () => {
  /** Customers ← (one) — (many) → Orders. Orders' name looks up the customer's
   * title through a lookup field. Returns the ids the tests below drive. */
  async function setupOrdersCustomers() {
    const customersDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Customers ${Date.now()}` })).json().id;
    const ordersDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Orders ${Date.now()}` })).json().id;

    // one_to_many: many orders (side a) → one customer (side b). The `customer`
    // field on Orders is therefore to-one, so its lookup resolves to a single value.
    await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: ordersDb, database_b_id: customersDb,
      cardinality: 'one_to_many', field_a_name: 'Customer', field_b_name: 'Orders',
    });
    const ordersFields = (await inject('GET', `/workspaces/${wsId}/databases/${ordersDb}`)).json().fields;
    const customerFieldId = ordersFields.find((f: { apiName: string }) => f.apiName === 'customer').id;
    const ordersTitleFieldId = ordersFields.find((f: { type: string }) => f.type === 'title').id;

    // Lookup the customer's TITLE (`name`) onto each order as `customer_name`.
    const lookup = await inject('POST', `/workspaces/${wsId}/databases/${ordersDb}/fields`, {
      display_name: 'Customer Name', type: 'lookup',
      config: { relation_field_id: customerFieldId, target_field_api_name: 'name' },
    });
    expect(lookup.statusCode, lookup.body).toBe(201);

    return { customersDb, ordersDb, customerFieldId, ordersTitleFieldId };
  }

  /** The reactive recompute is fire-and-forget — poll the persisted title. */
  async function pollTitle(dbId: string, recId: string, expected: string): Promise<string> {
    let title = '';
    for (let i = 0; i < 40; i++) {
      title = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`)).json().title;
      if (title === expected) return title;
      await new Promise((r) => setTimeout(r, 50));
    }
    return title;
  }

  it('allows a lookup reference in the title template, but still rejects a direct relation traversal', async () => {
    const { ordersDb, ordersTitleFieldId } = await setupOrdersCustomers();

    // Lookup ref → allowed (this is the whole point of #132).
    const ok = await setComputed(ordersDb, ordersTitleFieldId, 'concat("Order for ", {Customer Name})');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().config.name_mode).toBe('computed');

    // Direct relation traversal → still rejected (deferred to #145).
    const bad = await setComputed(ordersDb, ordersTitleFieldId, 'concat("Order for ", {Customer})');
    expect(bad.statusCode, bad.body).toBe(422);
  });

  it('computes the title from a related record\'s title via the lookup', async () => {
    const { customersDb, ordersDb, customerFieldId, ordersTitleFieldId } = await setupOrdersCustomers();
    await setComputed(ordersDb, ordersTitleFieldId, 'concat("Order for ", {Customer Name})');

    const acme = (await inject('POST', `/workspaces/${wsId}/databases/${customersDb}/records`, { values: { name: 'Acme' } })).json();
    const order = (await inject('POST', `/workspaces/${wsId}/databases/${ordersDb}/records`, { values: {} })).json();

    // Linking the order to the customer is the case-(b) cascade → its cross-record
    // name resolves once the lookup materializes.
    const link = await inject('PUT', `/workspaces/${wsId}/databases/${ordersDb}/records/${order.id}/links/${customerFieldId}`, {
      record_ids: [acme.id],
    });
    expect(link.statusCode, link.body).toBeLessThan(300);

    expect(await pollTitle(ordersDb, order.id, 'Order for Acme')).toBe('Order for Acme');
  });

  it('recomputes the dependent title LIVE when the related record changes — without re-saving the order', async () => {
    const { customersDb, ordersDb, customerFieldId, ordersTitleFieldId } = await setupOrdersCustomers();
    await setComputed(ordersDb, ordersTitleFieldId, 'concat("Order for ", {Customer Name})');

    const cust = (await inject('POST', `/workspaces/${wsId}/databases/${customersDb}/records`, { values: { name: 'Before' } })).json();
    const order = (await inject('POST', `/workspaces/${wsId}/databases/${ordersDb}/records`, { values: {} })).json();
    await inject('PUT', `/workspaces/${wsId}/databases/${ordersDb}/records/${order.id}/links/${customerFieldId}`, {
      record_ids: [cust.id],
    });
    expect(await pollTitle(ordersDb, order.id, 'Order for Before')).toBe('Order for Before');

    // Rename the CUSTOMER only. The order is never touched again.
    const renamed = await inject('PATCH', `/workspaces/${wsId}/databases/${customersDb}/records/${cust.id}`, {
      values: { name: 'After' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    // The order's persisted title follows the related record — via the MN-267
    // invalidation path, reactively.
    expect(await pollTitle(ordersDb, order.id, 'Order for After')).toBe('Order for After');
  });
});
