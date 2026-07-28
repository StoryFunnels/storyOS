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
