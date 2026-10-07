import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let token: string;

async function req(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Prefs')).token;
});
afterAll(async () => {
  await app.close();
});

describe('user preferences — My Work config (MN-072 part 2)', () => {
  it('defaults include an empty myWork map', async () => {
    const res = await req('GET', '/users/me/preferences');
    expect(res.statusCode).toBe(200);
    expect(res.json().myWork).toEqual({});
  });

  it('persists per-database My Work config', async () => {
    const config = {
      group_by_field_id: '11111111-1111-1111-1111-111111111111',
      color_by_field_id: '22222222-2222-2222-2222-222222222222',
      hidden_field_ids: ['33333333-3333-3333-3333-333333333333'],
      filters: { and: [{ field: 'status', op: 'eq', value: 'open' }] },
    };
    const patch = await req('PATCH', '/users/me/preferences', { myWork: { 'db-1': config } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().myWork['db-1']).toEqual(config);

    const get = await req('GET', '/users/me/preferences');
    expect(get.json().myWork['db-1']).toEqual(config);
  });

  it('a later notifications patch does NOT drop myWork (the reconstruct gotcha)', async () => {
    await req('PATCH', '/users/me/preferences', { notifications: { assigned: false } });
    const get = await req('GET', '/users/me/preferences');
    expect(get.json().myWork['db-1']).toBeDefined();
    expect(get.json().notifications.assigned).toBe(false);
  });

  it('merges per-database — a second database config coexists', async () => {
    await req('PATCH', '/users/me/preferences', { myWork: { 'db-2': { group_by_field_id: 'x' } } });
    const get = await req('GET', '/users/me/preferences');
    expect(get.json().myWork['db-1']).toBeDefined();
    expect(get.json().myWork['db-2'].group_by_field_id).toBe('x');
  });
});

describe('user preferences — activation checklist dismissal (#155)', () => {
  it('defaults to an empty dismissed-workspaces list', async () => {
    const res = await req('GET', '/users/me/preferences');
    expect(res.statusCode).toBe(200);
    expect(res.json().activation).toEqual({ dismissedWorkspaces: [] });
  });

  it('persists a per-workspace dismissal', async () => {
    const patch = await req('PATCH', '/users/me/preferences', {
      activation: { dismissedWorkspaces: ['ws-1'] },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().activation.dismissedWorkspaces).toEqual(['ws-1']);

    const get = await req('GET', '/users/me/preferences');
    expect(get.json().activation.dismissedWorkspaces).toEqual(['ws-1']);
  });

  it('replaces the list on patch — a second workspace can be added, and one removed', async () => {
    await req('PATCH', '/users/me/preferences', { activation: { dismissedWorkspaces: ['ws-1', 'ws-2'] } });
    let get = await req('GET', '/users/me/preferences');
    expect(get.json().activation.dismissedWorkspaces).toEqual(['ws-1', 'ws-2']);

    // "Undo dismiss" for ws-1: the client sends the full next list without it.
    await req('PATCH', '/users/me/preferences', { activation: { dismissedWorkspaces: ['ws-2'] } });
    get = await req('GET', '/users/me/preferences');
    expect(get.json().activation.dismissedWorkspaces).toEqual(['ws-2']);
  });

  it('an unrelated patch does NOT drop the dismissal (the reconstruct gotcha)', async () => {
    await req('PATCH', '/users/me/preferences', { regional: { dateFormat: 'DMY' } });
    const get = await req('GET', '/users/me/preferences');
    expect(get.json().activation.dismissedWorkspaces).toEqual(['ws-2']);
    expect(get.json().regional.dateFormat).toBe('DMY');
  });
});

describe('user preferences — sidebar views-only mode (#775)', () => {
  it('defaults to no workspaces in views-only mode', async () => {
    const res = await req('GET', '/users/me/preferences');
    expect(res.statusCode).toBe(200);
    expect(res.json().sidebar).toEqual({ viewsOnlyWorkspaces: [] });
  });

  it('persists a per-workspace choice server-side', async () => {
    const patch = await req('PATCH', '/users/me/preferences', { sidebar: { viewsOnlyWorkspaces: ['ws-1'] } });
    expect(patch.statusCode, patch.body).toBe(200);
    const get = await req('GET', '/users/me/preferences');
    expect(get.json().sidebar.viewsOnlyWorkspaces).toEqual(['ws-1']);
  });

  it('replaces the list — turning it off for one workspace keeps the others', async () => {
    await req('PATCH', '/users/me/preferences', { sidebar: { viewsOnlyWorkspaces: ['ws-1', 'ws-2'] } });
    await req('PATCH', '/users/me/preferences', { sidebar: { viewsOnlyWorkspaces: ['ws-2'] } });
    const get = await req('GET', '/users/me/preferences');
    expect(get.json().sidebar.viewsOnlyWorkspaces).toEqual(['ws-2']);
  });

  it('an unrelated patch does NOT switch it back off (the reconstruct gotcha)', async () => {
    await req('PATCH', '/users/me/preferences', { regional: { dateFormat: 'YMD' } });
    const get = await req('GET', '/users/me/preferences');
    expect(get.json().sidebar.viewsOnlyWorkspaces).toEqual(['ws-2']);
  });

  it('rejects a malformed list rather than storing it', async () => {
    const res = await req('PATCH', '/users/me/preferences', { sidebar: { viewsOnlyWorkspaces: 'ws-1' } });
    expect(res.statusCode).toBe(422);
  });

  // AC5: the toggle is its owner's alone. A second member must read the default,
  // never the first member's choice (#736's defect, were it workspace-shared).
  it('is invisible to every other user', async () => {
    const other = (await signUpUser(app, 'Prefs Other')).token;
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me/preferences', headers: authed(other) });
    expect(res.json().sidebar.viewsOnlyWorkspaces).toEqual([]);
  });
});
