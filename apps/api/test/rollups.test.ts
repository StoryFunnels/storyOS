import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let membersDb: string;
let timeoffDb: string;
let memberFieldId: string; // relation field on Time Off → Members
let timeoffFieldId: string; // inverse relation field on Members → Time Off
let relId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Ron');
  wsId = (await inject('POST', '/workspaces', { name: 'Rollup WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  membersDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Members' })).json().id;
  timeoffDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Time Off' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, { display_name: 'Allocation', type: 'number' });
  await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/fields`, { display_name: 'Days', type: 'number' });

  relId = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: timeoffDb, database_b_id: membersDb,
    cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off',
  })).json().id;
  const timeoffFields = (await inject('GET', `/workspaces/${wsId}/databases/${timeoffDb}`)).json().fields;
  memberFieldId = timeoffFields.find((f: { apiName: string }) => f.apiName === 'member').id;
  const memberFields = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}`)).json().fields;
  timeoffFieldId = memberFields.find((f: { apiName: string }) => f.apiName === 'time_off').id;
});

afterAll(async () => {
  await app.close();
});

describe('rollup fields (MN-064)', () => {
  it('validates config: op required, non-count needs a NUMBER target', async () => {
    const noOp = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Broken', type: 'rollup', config: { relation_field_id: timeoffFieldId },
    });
    expect(noOp.statusCode).toBe(422);
    const sumNoTarget = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Broken2', type: 'rollup', config: { relation_field_id: timeoffFieldId, op: 'sum' },
    });
    expect(sumNoTarget.statusCode).toBe(422);
    const sumOverText = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Broken3', type: 'rollup',
      config: { relation_field_id: timeoffFieldId, op: 'sum', target_field_api_name: 'name' },
    });
    expect(sumOverText.statusCode).toBe(422);
  });

  it('aggregates: count with no target, sum over numbers; empty relation → 0 / null', async () => {
    const count = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Requests', type: 'rollup', config: { relation_field_id: timeoffFieldId, op: 'count' },
    });
    expect(count.statusCode, count.body).toBe(201);
    const sum = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Days Used', type: 'rollup',
      config: { relation_field_id: timeoffFieldId, op: 'sum', target_field_api_name: 'days' },
    });
    expect(sum.statusCode, sum.body).toBe(201);

    const ana = (await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, { values: { name: 'Ana', allocation: 24 } })).json();
    const bob = (await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, { values: { name: 'Bob', allocation: 20 } })).json();
    for (const [title, days] of [['Trip', 5], ['Sick', 2]] as const) {
      const rec = (await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, { values: { name: title, days } })).json();
      const link = await inject('PUT', `/workspaces/${wsId}/databases/${timeoffDb}/records/${rec.id}/links/${memberFieldId}`, {
        record_ids: [ana.id],
      });
      expect(link.statusCode, link.body).toBeLessThan(300);
    }

    const list = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records?limit=50`)).json();
    const anaRow = list.data.find((r: { id: string }) => r.id === ana.id);
    expect(anaRow.values.requests).toBe(2);
    expect(anaRow.values.days_used).toBe(7);
    const bobRow = list.data.find((r: { id: string }) => r.id === bob.id);
    expect(bobRow.values.requests).toBe(0); // empty relation → 0 for count
    expect(bobRow.values.days_used).toBeNull(); // …and null for sum
  });

  it('rejects writes to rollup values', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, {
      values: { name: 'Cheater', days_used: 99 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('formulas reference rollups: {Allocation} - {Days Used} closes the vacations story', async () => {
    const formula = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Balance', type: 'formula', config: { expression: '{Allocation} - {Days Used}' },
    });
    expect(formula.statusCode, formula.body).toBe(201);
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records?limit=50`)).json();
    const ana = list.data.find((r: { title: string }) => r.title === 'Ana');
    expect(ana.values.balance).toBe(17); // 24 − 7
  });

  it('min/max/avg ops work', async () => {
    for (const op of ['min', 'max', 'avg'] as const) {
      const res = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
        display_name: `Days ${op}`, type: 'rollup',
        config: { relation_field_id: timeoffFieldId, op, target_field_api_name: 'days' },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records?limit=50`)).json();
    const ana = list.data.find((r: { title: string }) => r.title === 'Ana');
    expect(ana.values.days_min).toBe(2);
    expect(ana.values.days_max).toBe(5);
    expect(ana.values.days_avg).toBe(3.5);
  });

  it('cascades: deleting the relation removes dependent rollups', async () => {
    const detailBefore = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}`)).json();
    expect(detailBefore.fields.some((f: { type: string }) => f.type === 'rollup')).toBe(true);
    const del = await inject('DELETE', `/workspaces/${wsId}/relations/${relId}`, { confirm: true });
    expect([200, 204]).toContain(del.statusCode);
    const detailAfter = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}`)).json();
    expect(detailAfter.fields.some((f: { type: string }) => f.type === 'rollup')).toBe(false);
  });
});
