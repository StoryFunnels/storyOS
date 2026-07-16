import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-118: a user field must store a real user id.
 *
 * It used to accept ANY string, so `assignee: "Ievgen"` was stored verbatim and
 * echoed back as success — the UI rendered "(unknown)" and ~28 records were
 * silently unassigned. An agent verifying its own write by reading the echo would
 * report success. That is the failure mode this test exists to prevent.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let mate: { token: string; email: string };
let adminId: string;
let mateId: string;
let wsId: string;
let dbId: string;
let assigneeField: string;

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Ievgen');
  mate = await signUpUser(app, 'Maya');
  adminId = (await inject('GET', '/me')).json().id;
  mateId = (await inject('GET', '/me', undefined, mate.token)).json().id;

  wsId = (await inject('POST', '/workspaces', { name: 'People WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  assigneeField = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Assignee',
      type: 'user',
    })
  ).json().id;

  const invite = await inject('POST', `/workspaces/${wsId}/invites`, { email: mate.email, role: 'member' });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await inject('POST', '/invites/accept', { token }, mate.token);
});

afterAll(async () => {
  await app.close();
});

describe('writing a person (MN-118)', () => {
  it('resolves a display name to the real user id — the exact case that corrupted 28 records', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'By name', assignee: 'Ievgen' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().values.assignee, 'the label must never be stored verbatim').toBe(adminId);
  });

  it('resolves an email', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'By email', assignee: mate.email },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().values.assignee).toBe(mateId);
  });

  it('accepts a plain user id, unchanged', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'By id', assignee: mateId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().values.assignee).toBe(mateId);
  });

  it('is case-insensitive on name and email', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Case', assignee: 'ievgen' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().values.assignee).toBe(adminId);
  });
});

describe('an unresolvable person FAILS LOUDLY (MN-118)', () => {
  it('refuses an unknown name and names the candidates, instead of echoing success', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Ghost', assignee: 'Nobody At All' },
    });
    expect(res.statusCode, 'silently storing this is the bug').toBe(422);
    const message = res.json().error.details[0].message;
    expect(message).toMatch(/no member "Nobody At All"/);
    // An agent's next turn should be able to self-correct from the error alone.
    expect(message).toMatch(/Ievgen/);
    expect(message).toMatch(/Maya/);
  });

  it('refuses a user id that is not a member of this workspace', async () => {
    const outsider = await signUpUser(app, 'Outsider');
    const outsiderId = (await inject('GET', '/me', undefined, outsider.token)).json().id;
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Cross-workspace', assignee: outsiderId },
    });
    expect(res.statusCode).toBe(422);
  });

  it('does not create the record when the person fails to resolve', async () => {
    const before = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 100 })).json().data.length;
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Should not exist', assignee: 'Nope' },
    });
    const after = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 100 })).json().data;
    expect(after.length).toBe(before);
    expect(after.some((r: { title: string }) => r.title === 'Should not exist')).toBe(false);
  });
});

describe('update + clear (MN-118)', () => {
  it('resolves on update too', async () => {
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Reassign' } })
    ).json();
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { assignee: 'Maya' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.assignee).toBe(mateId);
  });

  it('null still clears the field', async () => {
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: 'Clearable', assignee: 'Ievgen' },
      })
    ).json();
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { assignee: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.assignee ?? null).toBeNull();
  });

  it('read -> write round-trips without corrupting (the AC)', async () => {
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: 'Round trip', assignee: 'Maya' },
      })
    ).json();
    const read = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)).json();
    // Write back exactly what we read.
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { assignee: read.values.assignee },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.assignee).toBe(mateId);
  });
});

describe('batch + multi-user (MN-118)', () => {
  it('resolves names in a batch create', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
      records: [
        { values: { name: 'Bulk 1', assignee: 'Ievgen' } },
        { values: { name: 'Bulk 2', assignee: mate.email } },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.map((r: { values: { assignee: string } }) => r.values.assignee)).toEqual([
      adminId,
      mateId,
    ]);
  });

  it('one bad name fails the whole batch — no half-written people', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
      records: [{ values: { name: 'Good', assignee: 'Ievgen' } }, { values: { name: 'Bad', assignee: 'Ghost' } }],
    });
    expect(res.statusCode).toBe(422);
    const all = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 100 })).json().data;
    expect(all.some((r: { title: string }) => r.title === 'Good')).toBe(false);
  });

  it('resolves every entry of a multi-user field', async () => {
    const multi = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Reviewers',
        type: 'user',
        config: { multi: true },
      })
    ).json();
    expect(multi.id).toBeTruthy();
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Two reviewers', reviewers: ['Ievgen', mate.email] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().values.reviewers.sort()).toEqual([adminId, mateId].sort());
  });
});
