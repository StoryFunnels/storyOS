import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #539 — an agency operator's own brand (logo + accent colour) on the public
 * portal page (the shared-view page at /v/[token]). Deliberately a separate
 * concern from #556's `hide_branding` (public-view-branding.test.ts): that's
 * OUR "Powered by StoryOS" footer, paid-plan-gated; this is the OPERATOR's
 * own mark, shown regardless of plan.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let dbId: string;
let token: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}
/** Unauthenticated request — the public view path. */
async function pub(url: string) {
  return app.inject({ method: 'GET', url: `/api/v1${url}` });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PortalBrandingOwner');
  wsId = (await as('POST', '/workspaces', { name: '539 WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Portal Tasks' })).json().id;
  const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  const viewId = dbDetail.views[0].id;
  token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;
});

afterAll(async () => {
  await app.close();
});

describe('#539 — a workspace with no branding set renders unbranded', () => {
  it('the public view returns both branding fields as null by default', async () => {
    const res = await pub(`/public/views/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().branding).toEqual({ logo_url: null, accent_color: null });
  });
});

describe('#539 — setting branding round-trips into the public portal page, read-time', () => {
  it('PATCH workspace branding, then the public view reflects it with no re-share', async () => {
    const patch = await as('PATCH', `/workspaces/${wsId}`, {
      branding: { logo_url: 'https://agency.example.com/logo.png', accent_color: '#3366ff' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const res = await pub(`/public/views/${token}`);
    expect(res.json().branding).toEqual({
      logo_url: 'https://agency.example.com/logo.png',
      accent_color: '#3366ff',
    });
  });

  it('patching only accent_color leaves the already-set logo_url alone — a sub-merge, not a replace', async () => {
    const patch = await as('PATCH', `/workspaces/${wsId}`, { branding: { accent_color: '#ff0000' } });
    expect(patch.statusCode, patch.body).toBe(200);

    const res = await pub(`/public/views/${token}`);
    expect(res.json().branding).toEqual({
      logo_url: 'https://agency.example.com/logo.png',
      accent_color: '#ff0000',
    });
  });

  it('explicitly clearing one field with null removes just that one', async () => {
    const patch = await as('PATCH', `/workspaces/${wsId}`, { branding: { logo_url: null } });
    expect(patch.statusCode, patch.body).toBe(200);

    const res = await pub(`/public/views/${token}`);
    expect(res.json().branding).toEqual({ logo_url: null, accent_color: '#ff0000' });
  });
});

describe('#539 — validation: colour is data, not markup', () => {
  it('rejects a non-hex accent_color', async () => {
    const res = await as('PATCH', `/workspaces/${wsId}`, { branding: { accent_color: 'red' } });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an accent_color that could inject CSS (not a bare 6-digit hex)', async () => {
    const res = await as('PATCH', `/workspaces/${wsId}`, {
      branding: { accent_color: '#000000; background:url(javascript:alert(1))' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a non-https logo_url (never data:/javascript:/relative)', async () => {
    const dataUrl = await as('PATCH', `/workspaces/${wsId}`, {
      branding: { logo_url: 'data:text/html,<script>alert(1)</script>' },
    });
    expect(dataUrl.statusCode).toBe(422);

    const jsUrl = await as('PATCH', `/workspaces/${wsId}`, { branding: { logo_url: 'javascript:alert(1)' } });
    expect(jsUrl.statusCode).toBe(422);

    const httpUrl = await as('PATCH', `/workspaces/${wsId}`, { branding: { logo_url: 'http://insecure.example.com/a.png' } });
    expect(httpUrl.statusCode).toBe(422);
  });

  it('accepts a well-formed https logo_url', async () => {
    const res = await as('PATCH', `/workspaces/${wsId}`, {
      branding: { logo_url: 'https://cdn.example.com/brand/logo.svg' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('#539 — MUST KEEP WORKING: #556\'s hide_branding is unaffected by any of this', () => {
  it('hide_branding is still present and still false on a free plan, alongside the new branding field', async () => {
    const res = await pub(`/public/views/${token}`);
    expect(res.json().hide_branding).toBe(false);
    expect(res.json()).toHaveProperty('branding');
  });
});
