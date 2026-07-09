import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let recId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Formulator');
  wsId = (await inject('POST', '/workspaces', { name: 'Formula WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Estimate', type: 'number', config: {} });
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Spent', type: 'number', config: {} });
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'State', type: 'select', config: {}, options: [{ label: 'Open' }, { label: 'Done' }],
  });
  recId = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name: 'Alpha', estimate: 10, spent: 4 },
  })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('formula fields (MN-043)', () => {
  it('computes arithmetic and updates live', async () => {
    const created = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Remaining', type: 'formula', config: { expression: '{Estimate} - {Spent}' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().config.result_type).toBe('number');

    let rec = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`)).json();
    expect(rec.values.remaining).toBe(6);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`, { values: { spent: 9 } });
    rec = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`)).json();
    expect(rec.values.remaining).toBe(1);
  });

  it('compares select labels and chains formula-over-formula', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const state = detail.fields.find((f: { apiName: string }) => f.apiName === 'state');
    const done = state.options.find((o: { label: string }) => o.label === 'Done').id;
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`, { values: { state: done } });

    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Health', type: 'formula',
      config: { expression: 'if({State} == "Done", "🟢", if({Remaining} < 2, "🟡", "🔴"))' },
    });
    const rec = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`)).json();
    expect(rec.values.health).toBe('🟢');
  });

  it('rejects writes, bad syntax, unknown refs, and type errors at save', async () => {
    const write = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`, {
      values: { remaining: 99 },
    });
    expect(write.statusCode).toBe(422);

    for (const expression of ['{Nope} + 1', '{State} * 2', 'if({Estimate}, 1, 2)', '1 +']) {
      const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: `Bad ${expression.slice(0, 6)}`, type: 'formula', config: { expression },
      });
      expect(res.statusCode, expression).toBe(422);
    }
  });

  it('degrades to null when a referenced field is deleted (no crash)', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const spent = detail.fields.find((f: { apiName: string }) => f.apiName === 'spent');
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${spent.id}`);
    const rec = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`);
    expect(rec.statusCode).toBe(200);
    expect(rec.json().values.remaining).toBe(null);
  });
});
