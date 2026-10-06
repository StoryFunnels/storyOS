import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #795 AC1 — `groupedAggregate` accepts `multi_select` and `checkbox`.
 *
 * Dashboard chart widgets already OFFER both groupings, but could only compute them
 * by paging the whole database into the browser, because the server refused them.
 *
 * The contract is the client's own: `groupKeysForRecord` / `computeChartSeries` in
 * apps/web (dashboard-charts.ts). The reference implementation below is a deliberate
 * copy of that bucketing, so "identical totals to today's client-computed series"
 * (AC5) is asserted against independent code over real stored data, rather than
 * against numbers I chose to fit the SQL.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;
let dbId: string;
let tagsApi: string;
let doneApi: string;
let amountApi: string;
let optionId: Record<string, string>;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

const grouped = async (body: unknown, token = admin.token, db = dbId) => {
  const res = await as(token, 'POST', `/workspaces/${wsId}/databases/${db}/records/aggregate/grouped`, body);
  return { status: res.statusCode, body: res.json() };
};
const asMap = (groups: Array<{ key: string | null; value: number | null }>) =>
  Object.fromEntries(groups.map((g) => [String(g.key), g.value]));

/** The client's bucketing (apps/web dashboard-charts.ts groupKeysForRecord), copied on purpose. */
function referenceKeys(value: unknown): (string | null)[] {
  if (Array.isArray(value)) return value.length === 0 ? [null] : value.map((v) => (v == null ? null : String(v)));
  if (value == null || value === '') return [null];
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  return [String(value)];
}
function referenceSeries(rows: Array<Record<string, unknown>>, groupApi: string, sumApi?: string) {
  const out = new Map<string, { count: number; sum: number }>();
  for (const row of rows) {
    // A DISTINCT key per record: a record counts once in each group it belongs to.
    for (const key of new Set(referenceKeys(row[groupApi]))) {
      const k = String(key);
      const e = out.get(k) ?? { count: 0, sum: 0 };
      e.count += 1;
      if (sumApi && typeof row[sumApi] === 'number') e.sum += row[sumApi] as number;
      out.set(k, e);
    }
  }
  return out;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'GroupedMultiCheckbox');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Multi Co' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  const tags = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Tags', type: 'multi_select', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
  })).json();
  tagsApi = tags.apiName;
  optionId = Object.fromEntries(tags.options.map((o: { id: string; label: string }) => [o.label, o.id]));
  doneApi = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Done', type: 'checkbox' })).json().apiName;
  amountApi = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Amount', type: 'number' })).json().apiName;

  const rec = (values: Record<string, unknown>) =>
    as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values });
  await rec({ name: 'r1', [tagsApi]: [optionId.a, optionId.b], [doneApi]: true, [amountApi]: 10 });
  await rec({ name: 'r2', [tagsApi]: [optionId.a], [doneApi]: true, [amountApi]: 5 });
  await rec({ name: 'r3', [tagsApi]: [optionId.b, optionId.c], [doneApi]: false, [amountApi]: 7 });
  await rec({ name: 'r4', [tagsApi]: [], [doneApi]: false, [amountApi]: 3 });
  await rec({ name: 'r5', [amountApi]: 1 }); // no tags, checkbox never set
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#795 — grouped by multi_select: one group per option', () => {
  it('counts a record in EVERY one of its options, so the groups can add up to more than the records', async () => {
    const { status, body } = await grouped({ op: 'count', group_by: tagsApi });
    expect(status, JSON.stringify(body)).toBe(200);
    const g = asMap(body.groups);
    expect(g[optionId.a!]).toBe(2); // r1, r2
    expect(g[optionId.b!]).toBe(2); // r1, r3
    expect(g[optionId.c!]).toBe(1); // r3
    const total = body.groups.reduce((n: number, x: { value: number }) => n + x.value, 0);
    expect(total).toBeGreaterThan(5); // 5 records, but r1 and r3 each count twice: that is the semantics
  });

  it('puts a record with no options, an empty array, or no value at all in the null group', async () => {
    const { body } = await grouped({ op: 'count', group_by: tagsApi });
    expect(asMap(body.groups)['null']).toBe(2); // r4 (empty) and r5 (absent)
  });

  it('aggregates a numeric field per option: a record contributes its value to each of its groups', async () => {
    const { body } = await grouped({ op: 'sum', field: amountApi, group_by: tagsApi });
    const g = asMap(body.groups);
    expect(g[optionId.a!]).toBe(15); // r1 10 + r2 5
    expect(g[optionId.b!]).toBe(17); // r1 10 + r3 7
    expect(g[optionId.c!]).toBe(7); // r3
    expect(g['null']).toBe(4); // r4 3 + r5 1
  });

  it('respects filter: only the matching records are expanded and counted', async () => {
    const { body } = await grouped({
      op: 'count',
      group_by: tagsApi,
      filter: { field: amountApi, op: 'gte', value: 7 },
    });
    const g = asMap(body.groups);
    expect(g[optionId.a!]).toBe(1); // r1
    expect(g[optionId.b!]).toBe(2); // r1, r3
    expect(g[optionId.c!]).toBe(1); // r3
    expect(g['null']).toBeUndefined();
  });
});

describe('#795 — grouped by checkbox', () => {
  it("keys are 'true' / 'false', and a record that never had the box set is the null group", async () => {
    const { status, body } = await grouped({ op: 'count', group_by: doneApi });
    expect(status, JSON.stringify(body)).toBe(200);
    const g = asMap(body.groups);
    expect(g['true']).toBe(2); // r1, r2
    expect(g['false']).toBe(2); // r3, r4 (explicitly false)
    expect(g['null']).toBe(1); // r5
  });
});

describe('#795 AC5 — identical to what the client computes today, over the real stored data', () => {
  it.each([
    ['multi_select', () => tagsApi],
    ['checkbox', () => doneApi],
  ])('%s: count and sum match the client reference series, key for key', async (_label, pick) => {
    const groupApi = pick();
    const all = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 200 })).json().data as Array<{
      values: Record<string, unknown>;
    }>;
    expect(all.length).toBe(5);
    const expected = referenceSeries(all.map((r) => r.values), groupApi, amountApi);

    const counts = asMap((await grouped({ op: 'count', group_by: groupApi })).body.groups);
    const sums = asMap((await grouped({ op: 'sum', field: amountApi, group_by: groupApi })).body.groups);
    expect(Object.keys(counts).sort()).toEqual([...expected.keys()].sort());
    for (const [key, e] of expected) {
      expect(counts[key], `count for ${key}`).toBe(e.count);
      expect(sums[key], `sum for ${key}`).toBe(e.sum);
    }
  });
});

describe('#795 AC3 — a record-scoped guest only ever aggregates what they can read', () => {
  it.each([
    ['multi_select', 'multi_select', (o: string) => [o]],
    ['checkbox', 'checkbox', () => true],
  ])('%s: the guest does not get another record into their groups', async (_label, type, value) => {
    const database = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Guarded ${type}` })).json();
    const field = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/fields`, {
      display_name: 'Marker', type, ...(type === 'multi_select' ? { options: [{ label: 'only' }] } : {}),
    })).json();
    const opt = field.options?.[0]?.id ?? '';
    const v = (value as (o: string) => unknown)(opt);
    const granted = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records`, { values: { name: 'Granted', [field.apiName]: v } })).json();
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${database.id}/records`, { values: { name: 'Hidden', [field.apiName]: v } });

    const guest = await signUpUser(app, `Guest ${type}`);
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email, role: 'guest', grants: [{ record_id: granted.id, role: 'viewer' }],
    });
    await as(guest.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });

    const asGuest = await grouped({ op: 'count', group_by: field.apiName }, guest.token, database.id);
    expect(asGuest.status, JSON.stringify(asGuest.body)).toBe(200);
    expect(asGuest.body.groups).toEqual([{ key: type === 'checkbox' ? 'true' : opt, value: 1 }]);
    const asAdmin = await grouped({ op: 'count', group_by: field.apiName }, admin.token, database.id);
    expect(asAdmin.body.groups).toEqual([{ key: type === 'checkbox' ? 'true' : opt, value: 2 }]);
  });
});

describe('#795 — what is still refused', () => {
  it('a multi-person user field is still refused (a record would land in several groups with no meaningful key)', async () => {
    const field = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Watchers', type: 'user', config: { multi: true },
    })).json();
    const { status, body } = await grouped({ op: 'count', group_by: field.apiName });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('several groups');
  });
  it('a type with no sensible group key is refused, and the message now lists multi-select and checkbox', async () => {
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Site', type: 'url' });
    expect(created.statusCode, created.body).toBe(201); // fail HERE if the fixture is wrong, not three lines later
    const { status, body } = await grouped({ op: 'count', group_by: created.json().apiName });
    expect(status).toBe(422);
    const message: string = body.error.message;
    expect(message).toContain('cannot group by a "url" field');
    expect(message).toContain('multi-select');
    expect(message).toContain('checkbox');
  });
});
