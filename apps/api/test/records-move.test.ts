import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let stateOptions: Array<{ id: string; label: string }>;
let stateApiName = 'state';
let ids: string[] = [];

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

async function order(): Promise<string[]> {
  const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=50`);
  return res.json().data.map((r: { title: string }) => r.title);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Mover');
  wsId = (await inject('POST', '/workspaces', { name: 'Move WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  const state = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done' }],
    })
  ).json();
  stateOptions = state.options;
  stateApiName = state.apiName;

  const batch = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
    records: ['A', 'B', 'C', 'D'].map((name) => ({ values: { name } })),
  });
  ids = batch.json().data.map((r: { id: string }) => r.id);
});

afterAll(async () => {
  await app.close();
});

describe('record move (MN-022)', () => {
  it('moves after a neighbor', async () => {
    // Move A after C: B C A D
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${ids[0]}/move`, {
      after_record_id: ids[2],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await order()).toEqual(['B', 'C', 'A', 'D']);
  });

  it('moves before a neighbor', async () => {
    // Move D before B: D B C A
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${ids[3]}/move`, {
      before_record_id: ids[1],
    });
    expect(await order()).toEqual(['D', 'B', 'C', 'A']);
  });

  it('applies a value patch atomically with the move (kanban drop)', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${ids[0]}/move`, {
      after_record_id: ids[3],
      values: { [stateApiName]: stateOptions[1]!.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().values[stateApiName]).toBe(stateOptions[1]!.id);
    // A moved directly after D: D A B C
    expect(await order()).toEqual(['D', 'A', 'B', 'C']);
  });

  it('stays stable under repeated same-gap inserts (property-ish)', async () => {
    // Repeatedly move C between D and B — keys must stay unique + ordered.
    for (let i = 0; i < 30; i++) {
      const res = await inject(
        'POST',
        `/workspaces/${wsId}/databases/${dbId}/records/${ids[2]}/move`,
        { after_record_id: ids[3] },
      );
      expect(res.statusCode).toBe(201);
    }
    expect(await order()).toEqual(['D', 'C', 'A', 'B']);

    const positions = (
      await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=50`)
    )
      .json()
      .data.map((r: { position: string }) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort()).toEqual(positions);
  });

  it('rejects ambiguous input (both anchors)', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${ids[0]}/move`, {
      before_record_id: ids[1],
      after_record_id: ids[2],
    });
    expect(res.statusCode).toBe(422);
  });
});
