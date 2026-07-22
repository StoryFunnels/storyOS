import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/** MN-213 (#139): Getting-Started state derives from what actually exists. */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(owner.token),
    payload: payload as never,
  });
}

const state = async () => (await inject('GET', `/workspaces/${ws}/onboarding`)).json();

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  ws = (await inject('POST', '/workspaces', { name: 'GS WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('live Getting-Started state (MN-213)', () => {
  it('starts false everywhere on an empty workspace', async () => {
    expect(await state()).toEqual({
      database_created: false,
      records_added: false,
      teammate_invited: false,
      board_view_built: false,
      relation_created: false,
      ai_connected: false,
      business_pack_installed: false,
    });
  });

  it('flips each step as the real thing happens — no stored flags', async () => {
    const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const db = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
    expect((await state()).database_created).toBe(true);

    await inject('POST', `/workspaces/${ws}/databases/${db}/records`, { values: {} });
    expect((await state()).records_added).toBe(true);

    const stateField = (
      await inject('POST', `/workspaces/${ws}/databases/${db}/fields`, {
        display_name: 'State',
        type: 'select',
        options: [{ label: 'To Do' }, { label: 'Done' }],
      })
    ).json();
    const view = await inject('POST', `/workspaces/${ws}/databases/${db}/views`, {
      name: 'Board',
      type: 'board',
      config: { group_by_field_id: stateField.id },
    });
    expect(view.statusCode, view.body).toBe(201);
    expect((await state()).board_view_built).toBe(true);

    const notes = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Notes' })).json().id;
    await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: db,
      database_b_id: notes,
      cardinality: 'many_to_many',
    });
    expect((await state()).relation_created).toBe(true);

    await inject('POST', `/workspaces/${ws}/invites`, { email: 'friend@test.storyos.dev', role: 'member' });
    expect((await state()).teammate_invited).toBe(true);

    await inject('POST', '/me/tokens', { name: 'AI', workspace_id: ws });
    expect((await state()).ai_connected).toBe(true);
  });

  it('flips business_pack_installed once a pack is installed, and back once fully uninstalled (MN-219 / #161)', async () => {
    const entry = (await inject('GET', '/packs/registry/support-inbox')).json();
    const install = await inject('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(install.statusCode, install.body).toBe(201);
    expect((await state()).business_pack_installed).toBe(true);

    const installs = (await inject('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{
      id: string;
      slug: string;
    }>;
    const tracked = installs.find((i) => i.slug === 'support-inbox')!;
    await inject('POST', `/workspaces/${ws}/packs/${tracked.id}/uninstall`);
    expect((await state()).business_pack_installed).toBe(false);
  });
});
