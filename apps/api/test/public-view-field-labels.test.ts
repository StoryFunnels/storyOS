import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #557 — `getPublicView`'s fields array only carried {api_name, type}. A
 * field's display label and a select/multi_select/workflow field's option
 * label/color are workspace SCHEMA, not personal data (#303's reasoning for
 * the public FORM page) — this mirrors forms.service.ts's own optsByField
 * shape exactly, and doesn't widen which fields are exposed.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let spaceId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}
async function pub(url: string) {
  return app.inject({ method: 'GET', url: `/api/v1${url}` });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PublicViewLabelsOwner');
  wsId = (await as('POST', '/workspaces', { name: '557 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

describe('#557 — public view fields carry a label and select-option colors', () => {
  it('every exposed field gets its display label, and a select field gets {id,label,color} options', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Labels DB' })).json().id;
    const status = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Deal Stage',
        type: 'select',
        options: [{ label: 'New', color: 'blue' }, { label: 'Won', color: 'green' }],
      })
    ).json();
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [status.apiName]: status.options[0].id } });

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;

    const body = await (await pub(`/public/views/${token}`)).json();
    const nameField = body.fields.find((f: { api_name: string }) => f.api_name === 'name');
    expect(nameField.label).toBe('Name');

    const stageField = body.fields.find((f: { api_name: string }) => f.api_name === status.apiName);
    expect(stageField.label).toBe('Deal Stage');
    expect(stageField.options).toEqual([
      expect.objectContaining({ label: 'New', color: 'blue' }),
      expect.objectContaining({ label: 'Won', color: 'green' }),
    ]);
  });

  it('a non-select field (text) carries a label but no options key at all', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'No Options DB' })).json().id;
    const note = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Note', type: 'text' })
    ).json();

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;

    const body = await (await pub(`/public/views/${token}`)).json();
    const noteField = body.fields.find((f: { api_name: string }) => f.api_name === note.apiName);
    expect(noteField.label).toBe('Note');
    expect(noteField).not.toHaveProperty('options');
  });

  it('MUST KEEP WORKING: a field NOT on the allowlist still gets no entry at all — label/options never widen exposure', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Still Hidden DB' })).json().id;
    const secret = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Secret Stage', type: 'select', options: [{ label: 'Hush' }] })
    ).json();

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, { visible_field_api_names: ['name'] })
    ).json().token;

    const body = await (await pub(`/public/views/${token}`)).json();
    expect(body.fields.some((f: { api_name: string }) => f.api_name === secret.apiName)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('Hush');
    expect(JSON.stringify(body)).not.toContain('Secret Stage');
  });
});
