import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #264 — publish a single view to the web. The leak cases matter more than
 * the happy path: a non-allowlisted field absent from the RESPONSE BODY, a
 * relation not on the include list absent, an included relation exposing
 * only the chip, a rollup/formula over hidden data gated behind an EXPLICIT
 * allowlist (never the "non-hidden fields" default), and revoke taking
 * effect immediately.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let spaceId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}
/** Unauthenticated request — the public view path. */
async function pub(method: string, url: string) {
  return app.inject({ method: method as never, url: `/api/v1${url}` });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PublicViewOwner');
  wsId = (await as('POST', '/workspaces', { name: '264 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

describe('publish / revoke: presence of the token is what makes a view reachable', () => {
  it('an unpublished view has no public link — GET 404s', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Unpublished' })).json().id;
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const res = await pub('GET', `/public/views/${viewId}`);
    expect(res.statusCode).toBe(404); // not even a valid token, but also: nothing is published yet
  });

  it('publishing mints a token; the public endpoint resolves it; revoking 404s the SAME url immediately', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Revoke Me' })).json().id;
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;

    const share = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {});
    expect(share.statusCode, share.body).toBeLessThan(300);
    const token = share.json().token;
    expect(token).toBeTruthy();

    const before = await pub('GET', `/public/views/${token}`);
    expect(before.statusCode, before.body).toBe(200);

    const revoke = await as('DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`);
    expect(revoke.statusCode, revoke.body).toBeLessThan(300);

    const after = await pub('GET', `/public/views/${token}`);
    expect(after.statusCode, 'revoke must take effect immediately, no cache').toBe(404);
  });

  it('re-sharing an already-published view keeps the SAME token', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Stable Token' })).json().id;
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;

    const first = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, { indexable: false });
    const second = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, { indexable: true });
    expect(first.json().token).toBe(second.json().token);
  });
});

describe('field allowlist: a non-allowlisted field is absent from the response BODY', () => {
  it('default (no explicit allowlist): a HIDDEN field is absent, a visible one is present', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Default Allowlist' })).json().id;
    const secret = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Secret Notes', type: 'text' })
    ).json();
    const open = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Public Notes', type: 'text' })
    ).json();
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { [secret.apiName]: 'the secret', [open.apiName]: 'the public part' },
    });
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}`, {
      config: { ...dbDetail.views[0].config, hidden_field_ids: [secret.id] },
    });

    const token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;
    const body = JSON.stringify(await (await pub('GET', `/public/views/${token}`)).json());
    expect(body).not.toContain('the secret');
    expect(body).toContain('the public part');
  });

  it('explicit allowlist: a field NOT named, even though not hidden, is absent', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Explicit Allowlist' })).json().id;
    const kept = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Kept', type: 'text' })
    ).json();
    const dropped = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Dropped', type: 'text' })
    ).json();
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { [kept.apiName]: 'keep this', [dropped.apiName]: 'drop this' },
    });

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
        visible_field_api_names: [kept.apiName],
      })
    ).json().token;

    const body = JSON.stringify(await (await pub('GET', `/public/views/${token}`)).json());
    expect(body).not.toContain('drop this');
    expect(body).toContain('keep this');
  });
});

describe('relations: only chip {id,title,number}, only when explicitly included', () => {
  it('a relation not on include_relation_api_names is absent entirely', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rel Source' })).json().id;
    const targetId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rel Target' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: targetId,
      cardinality: 'one_to_many',
      field_a_name: 'Linked',
    });
    const targetRec = (
      await as('POST', `/workspaces/${wsId}/databases/${targetId}/records`, { values: { name: 'Secret target title' } })
    ).json();
    const rec = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json();
    await as('PUT', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/links/${rel.json().field_a.id}`, {
      record_ids: [targetRec.id],
    });

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;

    const body = JSON.stringify(await (await pub('GET', `/public/views/${token}`)).json());
    expect(body, 'a relation not on the include list must not leak the target title').not.toContain('Secret target title');
  });

  it('an INCLUDED relation exposes only {id,title,number}, never the target record\'s other fields', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rel Source 2' })).json().id;
    const targetId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rel Target 2' })).json().id;
    const otherField = (
      await as('POST', `/workspaces/${wsId}/databases/${targetId}/fields`, { display_name: 'Other', type: 'text' })
    ).json();
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: targetId,
      cardinality: 'one_to_many',
      field_a_name: 'Linked',
    });
    const relField = rel.json().field_a;
    const targetRec = (
      await as('POST', `/workspaces/${wsId}/databases/${targetId}/records`, {
        values: { name: 'Visible chip title', [otherField.apiName]: 'must never leak' },
      })
    ).json();
    const rec = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json();
    await as('PUT', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/links/${relField.id}`, {
      record_ids: [targetRec.id],
    });

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const relFieldApiName = dbDetail.fields.find((f: { id: string }) => f.id === relField.id).apiName;
    const token = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
        include_relation_api_names: [relFieldApiName],
      })
    ).json().token;

    const publicBody = await (await pub('GET', `/public/views/${token}`)).json();
    const publicRec = publicBody.records.data.find((r: { id: string }) => r.id === rec.id);
    expect(publicRec.values[relFieldApiName]).toEqual([{ id: targetRec.id, title: 'Visible chip title', number: targetRec.number }]);
    expect(JSON.stringify(publicBody)).not.toContain('must never leak');
  });
});

describe('computed fields: rollup/formula never leak by the default allowlist, only by explicit opt-in', () => {
  it('a rollup is ABSENT under the default (non-hidden) allowlist even though it is not hidden', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rollup Source' })).json().id;
    const targetId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rollup Target' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: targetId,
      cardinality: 'one_to_many',
      field_a_name: 'Items',
    });
    const relField = rel.json().field_a;
    const rollup = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Item Count',
        type: 'rollup',
        config: { relation_field_id: relField.id, op: 'count' },
      })
    ).json();
    const rec = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json();

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    // No explicit visible_field_api_names — the default path.
    const token = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {})).json().token;

    const publicBody = await (await pub('GET', `/public/views/${token}`)).json();
    const publicRec = publicBody.records.data.find((r: { id: string }) => r.id === rec.id);
    expect(publicRec.values[rollup.apiName], 'a computed field must never ride the default allowlist').toBeUndefined();
  });

  it('the SAME rollup IS exposed once explicitly allowlisted', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rollup Source 2' })).json().id;
    const targetId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rollup Target 2' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: targetId,
      cardinality: 'one_to_many',
      field_a_name: 'Items',
    });
    const relField = rel.json().field_a;
    const rollup = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Item Count',
        type: 'rollup',
        config: { relation_field_id: relField.id, op: 'count' },
      })
    ).json();
    const targetRec = (await as('POST', `/workspaces/${wsId}/databases/${targetId}/records`, { values: {} })).json();
    const rec = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json();
    await as('PUT', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/links/${relField.id}`, {
      record_ids: [targetRec.id],
    });

    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const viewId = dbDetail.views[0].id;
    const token = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, {
        visible_field_api_names: [rollup.apiName],
      })
    ).json().token;

    const publicBody = await (await pub('GET', `/public/views/${token}`)).json();
    const publicRec = publicBody.records.data.find((r: { id: string }) => r.id === rec.id);
    expect(publicRec.values[rollup.apiName]).toBe(1);
  });
});

describe('MUST KEEP WORKING: public forms are unaffected by the share resolver (#264 AC3)', () => {
  it('a public form still resolves via its OWN token path, independent of view sharing', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Form Coexist' })).json().id;
    const nameField = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Contact Name', type: 'text' })
    ).json();
    const dbDetail = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const formView = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Contact',
      type: 'form',
      config: {
        sorts: [],
        hidden_field_ids: [],
        card_field_ids: [],
        column_widths: {},
        form: { access: 'public', public_token: 'coexist-form-tok', fields: [{ field_id: nameField.id }] },
      },
    });
    expect(formView.statusCode, formView.body).toBeLessThan(300);

    const def = await pub('GET', '/public/forms/coexist-form-tok');
    expect(def.statusCode, def.body).toBe(200);

    // And the table view in the same database can ALSO be shared, independently.
    const token = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${dbDetail.views[0].id}/share`, {})
    ).json().token;
    expect((await pub('GET', `/public/views/${token}`)).statusCode).toBe(200);
    // The form token must not resolve as a view, and vice versa.
    expect((await pub('GET', `/public/views/coexist-form-tok`)).statusCode).toBe(404);
    expect((await pub('GET', `/public/forms/${token}`)).statusCode).toBe(404);
  });
});

describe('MUST KEEP WORKING: an unpublished view is unaffected for signed-in users (#264 AC4)', () => {
  it('a view with no share config behaves identically for a signed-in read', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Untouched' })).json().id;
    const before = await (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    expect(before.views[0].config.share).toBeUndefined();
  });
});
