import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let companiesId: string;
let acmeId: string;
let leadsId: string;
let contactsId: string;
let leadStatusApi: string;
let leadPriorityApi: string;
let contactStatusApi: string;
let leadCompanyApi: string;
let contactCompanyApi: string;
let leadNewOptionId: string;
let contactNewOptionId: string;

function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Copier');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Copy WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  companiesId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Companies' })).json().id;
  acmeId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${companiesId}/records`, { values: { name: 'Acme' } })).json().id;

  leadsId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
  contactsId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Contacts' })).json().id;

  // Same-named select field on BOTH sides, but option ids are per-field —
  // this is the case that must be remapped by label, not copied raw.
  const leadStatus = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/fields`, {
    display_name: 'Status', type: 'select', options: [{ label: 'New' }, { label: 'Won' }],
  })).json();
  leadStatusApi = leadStatus.apiName;
  leadNewOptionId = leadStatus.options.find((o: { label: string }) => o.label === 'New').id;

  const contactStatus = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${contactsId}/fields`, {
    display_name: 'Status', type: 'select', options: [{ label: 'Won' }, { label: 'New' }],
  })).json();
  contactStatusApi = contactStatus.apiName;
  contactNewOptionId = contactStatus.options.find((o: { label: string }) => o.label === 'New').id;

  // A field with NO destination match — the blocking case.
  const leadPriority = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/fields`, {
    display_name: 'Priority', type: 'select', options: [{ label: 'Low' }, { label: 'High' }],
  })).json();
  leadPriorityApi = leadPriority.apiName;

  // Relation fields on BOTH sides pointing at the SAME target database.
  leadCompanyApi = (await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: leadsId, database_b_id: companiesId, cardinality: 'one_to_many', field_a_name: 'Company',
  })).json().field_a.api_name;
  contactCompanyApi = (await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: contactsId, database_b_id: companiesId, cardinality: 'one_to_many', field_a_name: 'Company',
  })).json().field_a.api_name;
});

afterAll(async () => {
  await app.close();
});

describe('copy-record (#521) — dry-run', () => {
  it('auto-matches by field name across databases, no blocking, with a sample', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records`, {
      values: { name: 'Jane Prospect', [leadStatusApi]: leadNewOptionId, [leadCompanyApi]: [acmeId] },
    })).json();

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      dry_run: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.dry_run).toBe(true);
    expect(body.will_create).toBe(1);
    expect(body.blocking).toBeUndefined();

    const statusPlan = body.plans.find((p: { sourceKey: string }) => p.sourceKey === leadStatusApi);
    expect(statusPlan.state).toBe('mapped');
    const priorityPlan = body.plans.find((p: { sourceKey: string }) => p.sourceKey === leadPriorityApi);
    expect(priorityPlan.state).toBe('skipped'); // no value on this record — nothing to lose
  });

  it('blocks when a field with a VALUE has no destination, and the response names why', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records`, {
      values: { name: 'Blocked Prospect', [leadPriorityApi]: (
        await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${leadsId}`)
      ).json().fields.find((f: { apiName: string }) => f.apiName === leadPriorityApi).options[0].id },
    })).json();

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      dry_run: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    const blocking = res.json().blocking;
    expect(blocking).toHaveLength(1);
    expect(blocking[0].sourceKey).toBe(leadPriorityApi);
  });
});

describe('copy-record (#521) — commit', () => {
  it('creates the record with the select value remapped by LABEL and the relation linked', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records`, {
      values: { name: 'Commit Prospect', [leadStatusApi]: leadNewOptionId, [leadCompanyApi]: [acmeId] },
    })).json();

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      dry_run: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.dry_run).toBe(false);
    expect(body.created).toHaveLength(1);

    const created = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${contactsId}/records/${body.created[0]}`)).json();
    expect(created.title).toBe('Commit Prospect');
    // The REMAPPED option id, never the source's — they're different ids for "New".
    expect(created.values[contactStatusApi]).toBe(contactNewOptionId);
    expect(created.values[contactStatusApi]).not.toBe(leadNewOptionId);
    expect(created.values[contactCompanyApi].map((c: { id: string }) => c.id)).toEqual([acmeId]);
  });

  it('refuses to commit a blocking field rather than silently dropping it', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records`, {
      values: { name: 'Refuse me', [leadPriorityApi]: (
        await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${leadsId}`)
      ).json().fields.find((f: { apiName: string }) => f.apiName === leadPriorityApi).options[0].id },
    })).json();

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      dry_run: false,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('no destination');

    // Nothing was created — refuse means refuse, not "created and let the
    // caller notice the field is missing".
    const contacts = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${contactsId}/records?q=Refuse me`)).json();
    expect(contacts.data).toHaveLength(0);
  });

  it('an explicit skip resolves the blocking field and the copy proceeds without it', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records`, {
      values: { name: 'Skip me', [leadPriorityApi]: (
        await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${leadsId}`)
      ).json().fields.find((f: { apiName: string }) => f.apiName === leadPriorityApi).options[0].id },
    })).json();

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      skip: [leadPriorityApi],
      dry_run: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().created).toHaveLength(1);
  });

  it('an empty relation never blocks and copies cleanly with nothing linked', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records`, {
      values: { name: 'No company yet' },
    })).json();

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      dry_run: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${contactsId}/records/${res.json().created[0]}`)).json();
    expect(created.values[contactCompanyApi] ?? []).toEqual([]);
  });
});

describe('copy-record (#521) — access', () => {
  it('a guest with only VIEWER access to the destination cannot commit (403)', async () => {
    const guest = await signUpUser(app, 'CopyGuest');
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [
        { space_id: spaceId, role: 'viewer' },
      ],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(guest.token, 'POST', '/invites/accept', { token });

    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records`, {
      values: { name: 'Guest cannot copy this in' },
    })).json();

    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      dry_run: false,
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('empty record_ids is refused up front, not silently a no-op', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: [],
      target_database_id: contactsId,
      dry_run: true,
    });
    expect(res.statusCode, res.body).toBe(422); // zod's own min(1) on record_ids
  });
});
