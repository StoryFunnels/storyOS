import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { billingSubscriptions } from '../src/db/schema';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #556 — `PublicViewsService` had no `BillingService` wiring at all, so a
 * published view's page had no way to know whether to hide the "Powered by
 * StoryOS" footer, unlike `FormsService`'s existing `hide_branding` (#269).
 * Mirrors that ticket's own test shape: force `billing_subscriptions`
 * directly (no real Stripe in tests), free by default, hidden once paid.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string };
let wsId: string;
let spaceId: string;
let token: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}
/** Unauthenticated request — the public view path. */
async function pub(url: string) {
  return app.inject({ method: 'GET', url: `/api/v1${url}` });
}

async function setPlan(plan: 'free' | 'pro' | 'business' | 'enterprise') {
  await db
    .insert(billingSubscriptions)
    .values({ workspaceId: wsId, plan, seats: 0 })
    .onConflictDoUpdate({ target: billingSubscriptions.workspaceId, set: { plan } });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'PublicViewBrandingOwner');
  wsId = (await as('POST', '/workspaces', { name: '556 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Branding Check' })).json().id;
  const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  const viewId = dbDetail.views[0].id;
  token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;
});

afterAll(async () => {
  await app.close();
});

describe('#556 — public view page footer follows the workspace plan, read-time', () => {
  it('"Powered by StoryOS" is present (hide_branding: false) for a free workspace by default', async () => {
    const res = await pub(`/public/views/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().hide_branding).toBe(false);
  });

  it('hide_branding flips to true immediately on a paid plan — no re-share needed, read-time', async () => {
    await setPlan('pro');
    const paid = await pub(`/public/views/${token}`);
    expect(paid.json().hide_branding).toBe(true);

    // And back down again — this is a live read of the current plan, not a
    // value baked in at share() time.
    await setPlan('free');
    const backToFree = await pub(`/public/views/${token}`);
    expect(backToFree.json().hide_branding).toBe(false);
  });

  it('MUST KEEP WORKING: the public FORM page\'s existing hide_branding behavior is unaffected', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Form Coexist 556' })).json().id;
    const nameField = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Contact Name', type: 'text' })
    ).json();
    const formView = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'A Form',
      type: 'form',
      config: {
        sorts: [],
        hidden_field_ids: [],
        card_field_ids: [],
        column_widths: {},
        form: { access: 'public', public_token: 'coexist-556-form-tok', fields: [{ field_id: nameField.id }] },
      },
    });
    expect(formView.statusCode, formView.body).toBeLessThan(300);

    await setPlan('free');
    expect((await pub('/public/forms/coexist-556-form-tok')).json().hide_branding).toBe(false);
    await setPlan('business');
    expect((await pub('/public/forms/coexist-556-form-tok')).json().hide_branding).toBe(true);
    await setPlan('free');
  });
});
