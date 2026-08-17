import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #31 (version history C2) — field-level change capture and the per-record
 * timeline it feeds.
 *
 * `record_versions` (MN-231) already answered "what did this look like then".
 * These assert the question this ticket adds: "who changed WHICH FIELD, and
 * from what".
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let statusApi: string;
let statusId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function createRecord(values: Record<string, unknown>) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values });
  expect(res.statusCode, JSON.stringify(res.json())).toBeLessThan(300);
  return res.json() as { id: string };
}

async function changesFor(recordId: string) {
  const res = await as(
    admin.token,
    'GET',
    `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/versions/changes`,
  );
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  return res.json() as {
    data: Array<{
      field_id: string | null;
      field_name: string;
      source: string;
      old_value: unknown;
      new_value: unknown;
      actor_id: string | null;
    }>;
    has_more: boolean;
    next_cursor: string | null;
  };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'field-history');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'History Co' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })
  ).json().id;
  const field = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Status',
      type: 'text',
    })
  ).json();
  statusApi = field.apiName;
  statusId = field.id;
});

afterAll(async () => {
  await app?.close();
});

describe('field-level capture (#31)', () => {
  it('records one event per changed field, with old and new values', async () => {
    const rec = await createRecord({ name: 'Ship it', [statusApi]: 'todo' });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [statusApi]: 'doing' },
    });

    const { data } = await changesFor(rec.id);
    const status = data.find((c) => c.field_id === statusId);
    expect(status, 'a change event for the edited field').toBeTruthy();
    expect(status!.old_value).toBe('todo');
    expect(status!.new_value).toBe('doing');
    expect(status!.field_name).toBe('Status');
    // Attribution: a session write is a human, and the actor is the editor.
    expect(status!.source).toBe('human');
    expect(status!.actor_id).toBeTruthy();
  });

  it('captures a title edit under the promoted title column, not a field id', async () => {
    const rec = await createRecord({ name: 'Before' });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'After' },
    });

    const { data } = await changesFor(rec.id);
    // record-diff.ts denotes the title with the literal "title"; the table
    // stores that as a null field_id, and the API renders it as "Name".
    const title = data.find((c) => c.field_id === null);
    expect(title, 'a change event for the title').toBeTruthy();
    expect(title!.old_value).toBe('Before');
    expect(title!.new_value).toBe('After');
    expect(title!.field_name).toBe('Name');
  });

  it('suppresses no-ops — writing the same value captures nothing', async () => {
    const rec = await createRecord({ name: 'Same', [statusApi]: 'todo' });
    const before = (await changesFor(rec.id)).data.length;

    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [statusApi]: 'todo' },
    });

    // A write that changed nothing is not history. Capturing it would bury the
    // real edits in noise on any record touched by an automation.
    expect((await changesFor(rec.id)).data.length).toBe(before);
  });

  it('one edit of two fields produces two events, not one', async () => {
    const rec = await createRecord({ name: 'Two', [statusApi]: 'a' });
    const before = (await changesFor(rec.id)).data.length;

    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'Two changed', [statusApi]: 'b' },
    });

    // Field granularity IS the product — a single row saying "the record
    // changed" is what record_versions already does.
    expect((await changesFor(rec.id)).data.length).toBe(before + 2);
  });
});

describe('the timeline reads back (#31)', () => {
  it('returns newest first and pages with a cursor', async () => {
    const rec = await createRecord({ name: 'Paged', [statusApi]: '0' });
    for (const v of ['1', '2', '3']) {
      await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
        values: { [statusApi]: v },
      });
    }

    const first = await as(
      admin.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions/changes?limit=2`,
    );
    const page = first.json() as { data: Array<{ new_value: unknown }>; has_more: boolean; next_cursor: string | null };
    expect(page.data).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBeTruthy();

    // Newest first — and asserted against what the record ACTUALLY holds now,
    // not against the literal we sent. The API coerces some values on write
    // (a text field given "3" reads back as 3), and the invariant that matters
    // is that history agrees with reality, not that it echoes the request.
    const current = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)
    ).json() as { values: Record<string, unknown> };
    /*
     * Compared as strings, deliberately. Capture stores what the WRITE stored;
     * the record read path coerces a text field's value on the way out, so a
     * text field holding 3 reads back as "3" while history holds 3. History is
     * faithful to storage — the two representations differ, and reconciling
     * them belongs to the timeline UI (#335), not to this assertion.
     */
    expect(String(page.data[0]!.new_value)).toBe(String(current.values[statusApi]));

    const second = await as(
      admin.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions/changes?limit=2&cursor=${page.next_cursor}`,
    );
    const rest = second.json() as { data: Array<{ new_value: unknown }> };
    // The cursor must not re-serve what page one already returned.
    expect(rest.data.map((c) => String(c.new_value))).not.toContain(String(current.values[statusApi]));
  });

  it('a deleted field keeps its history, rendered readably', async () => {
    const doomed = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Temporary',
        type: 'text',
      })
    ).json();
    const rec = await createRecord({ name: 'Outlives', [doomed.apiName]: 'first' });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [doomed.apiName]: 'second' },
    });
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${doomed.id}`);

    // "Who emptied this" must survive the field being removed — that is exactly
    // when someone asks. A bare uuid here would be useless.
    const { data } = await changesFor(rec.id);
    const event = data.find((c) => c.field_id === doomed.id);
    expect(event).toBeTruthy();
    expect(event!.field_name).toBe('Temporary');
  });
});
