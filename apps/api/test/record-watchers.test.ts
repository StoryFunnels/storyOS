import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { summarizeChanges } from '../src/records/record-change-summary';

/**
 * #236 — per-record watch/subscribe. A watcher (not necessarily an assignee or
 * mention target) gets a `record_changed` notification carrying a "what changed"
 * summary whenever the record's fields change.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let watcher: { token: string; email: string };
let watcherId: string;
let wsId: string;
let dbId: string;
let stateApi: string;
let todoId: string;
let doneId: string;
let notesApi: string;

function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

const recordChanged = (data: Array<{ type: string; snippet?: string | null }>) =>
  data.filter((n) => n.type === 'record_changed');

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Owner');
  watcher = await signUpUser(app, 'Watcher');
  watcherId = (await as(watcher.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Watch WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;

  const state = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Status',
    type: 'select',
    config: {},
    options: [{ label: 'Todo' }, { label: 'Done' }],
  })).json();
  stateApi = state.apiName;
  todoId = state.options.find((o: { label: string }) => o.label === 'Todo').id;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;
  notesApi = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Notes',
    type: 'text',
    config: {},
  })).json().apiName;

  // The watcher joins the workspace with a viewer grant on the space (enough to watch).
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: watcher.email,
    role: 'guest',
    grants: [{ space_id: spaceId, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(watcher.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('record watch/subscribe (#236)', () => {
  it('watch is idempotent and the watchers list reflects membership', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Watch me', [stateApi]: todoId },
    })).json();

    const w = await as(watcher.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watch`);
    expect(w.statusCode, w.body).toBe(201);
    // idempotent — a second watch doesn't error or duplicate
    await as(watcher.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watch`);

    const list = (await as(watcher.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watchers`)).json();
    expect(list.watching).toBe(true);
    expect(list.watchers).toContain(watcherId);
    expect(list.watchers.filter((id: string) => id === watcherId)).toHaveLength(1);
  });

  it('changing a watched record notifies the watcher with an old→new summary', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Ship it', [stateApi]: todoId },
    })).json();
    await as(watcher.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watch`);

    // The actor (admin) is NOT the watcher, so the watcher hears about it.
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });

    const notifs = (await as(watcher.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    const changed = recordChanged(notifs.data);
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed[0].snippet).toContain('Status');
    expect(changed[0].snippet).toContain('Todo');
    expect(changed[0].snippet).toContain('Done');
  });

  it('does not notify the actor about their own change', async () => {
    // admin watches their own record, then edits it — no self-ping.
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Mine', [stateApi]: todoId },
    })).json();
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watch`);
    const before = recordChanged((await as(admin.token, 'GET', `/workspaces/${wsId}/notifications`)).json().data).length;
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [notesApi]: 'self edit' },
    });
    const after = recordChanged((await as(admin.token, 'GET', `/workspaces/${wsId}/notifications`)).json().data).length;
    expect(after).toBe(before);
  });

  it('unwatching stops further change notifications', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Leaving', [stateApi]: todoId },
    })).json();
    await as(watcher.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watch`);
    const unwatch = await as(watcher.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watch`);
    expect(unwatch.statusCode).toBe(200);
    expect((await as(watcher.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/watchers`)).json().watching).toBe(false);

    const before = recordChanged((await as(watcher.token, 'GET', `/workspaces/${wsId}/notifications`)).json().data).length;
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [notesApi]: 'edited after unwatch' },
    });
    const after = recordChanged((await as(watcher.token, 'GET', `/workspaces/${wsId}/notifications`)).json().data).length;
    expect(after).toBe(before);
  });
});

describe('summarizeChanges (#236)', () => {
  it('renders "Field: from → to" and resolves select option labels', () => {
    const labels = new Map([
      ['t', 'Todo'],
      ['d', 'Done'],
    ]);
    const out = summarizeChanges([{ id: 'f1', label: 'Status', type: 'select' }], { f1: 't' }, { f1: 'd' }, labels);
    expect(out).toBe('Status: Todo → Done');
  });

  it('shows "empty" for a cleared value and skips no-op fields', () => {
    const out = summarizeChanges(
      [
        { id: 'a', label: 'Notes', type: 'text' },
        { id: 'b', label: 'Unchanged', type: 'text' },
      ],
      { a: 'hi', b: 'same' },
      { a: null, b: 'same' },
      new Map(),
    );
    expect(out).toBe('Notes: hi → empty');
  });

  it('caps a bulk edit with "+N more"', () => {
    const fields = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, label: `F${i}`, type: 'text' }));
    const before = Object.fromEntries(fields.map((f) => [f.id, 'x']));
    const after = Object.fromEntries(fields.map((f) => [f.id, 'y']));
    const out = summarizeChanges(fields, before, after, new Map(), { max: 5 });
    expect(out).toContain('+2 more');
  });
});
