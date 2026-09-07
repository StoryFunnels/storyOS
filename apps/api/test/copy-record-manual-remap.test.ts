import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #605 — split from #561 during a backlog audit. Real infrastructure already
 * existed (copy-record.service.ts + copy-mapping.ts's planField/skip), but a
 * client could only SKIP a blocking/ambiguous field, never choose a specific
 * destination — this adds `override`: source field api_name -> destination
 * field id, honored instead of auto-match (or a skip), and how an ambiguous
 * relation is resolved by NAMING a candidate rather than only skipping it.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let notesId: string;
let contactsId: string;
let companiesId: string;
let acmeId: string;
let globexId: string;
let notesTitleFieldApi: string;
let contactsBioApi: string;
let contactsCompanyPrimaryApi: string;
let contactsCompanySecondaryApi: string;

function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Remapper');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '605 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  companiesId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Companies' })).json().id;
  acmeId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${companiesId}/records`, { values: { name: 'Acme' } })).json().id;
  globexId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${companiesId}/records`, { values: { name: 'Globex' } })).json().id;

  notesId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Notes' })).json().id;
  const notesText = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/fields`, { display_name: 'Text', type: 'text' })
  ).json();
  notesTitleFieldApi = notesText.apiName;

  contactsId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Contacts' })).json().id;
  const contactsBio = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${contactsId}/fields`, { display_name: 'Bio', type: 'text' })
  ).json();
  contactsBioApi = contactsBio.apiName;

  // Two relations from Contacts to Companies — the ambiguous case.
  contactsCompanyPrimaryApi = (await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: contactsId, database_b_id: companiesId, cardinality: 'one_to_many', field_a_name: 'Primary Company',
  })).json().field_a.api_name;
  contactsCompanySecondaryApi = (await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: contactsId, database_b_id: companiesId, cardinality: 'one_to_many', field_a_name: 'Secondary Company',
  })).json().field_a.api_name;

  // Notes gets its own relation to Companies, so its "company" copy is ALSO ambiguous.
  await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: notesId, database_b_id: companiesId, cardinality: 'one_to_many', field_a_name: 'Company',
  });
});

afterAll(async () => {
  await app.close();
});

describe('#605 — override redirects a scalar field to a client-chosen destination', () => {
  it('maps "Text" onto "Bio" instead of being blocked (no name match, but it has a value)', async () => {
    const rec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records`, { values: { [notesTitleFieldApi]: 'Met at the conference' } })
    ).json();

    const dry = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      dry_run: true,
    });
    expect(dry.statusCode, dry.body).toBe(201);
    const blockedPlan = dry.json().plans.find((p: { sourceKey: string }) => p.sourceKey === notesTitleFieldApi);
    expect(blockedPlan.state).toBe('blocking'); // confirms this really is the case override is needed for

    const commit = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      override: { [notesTitleFieldApi]: await destFieldId(contactsId, contactsBioApi) },
      // Notes' own "Company" relation is ALWAYS ambiguous against Contacts'
      // two relations to Companies (ambiguity blocks regardless of value —
      // pre-existing planField rule, unrelated to this field's override), so
      // it needs resolving too, just not what this test is about.
      skip: ['company'],
      dry_run: false,
    });
    expect(commit.statusCode, commit.body).toBe(201);
    const created = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${contactsId}/records/${commit.json().created[0]}`)
    ).json();
    expect(created.values[contactsBioApi]).toBe('Met at the conference');
  });

  async function destFieldId(databaseId: string, apiName: string): Promise<string> {
    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${databaseId}`);
    return detail.json().fields.find((f: { apiName: string }) => f.apiName === apiName).id;
  }
});

describe('#605 — an ambiguous relation is resolved by naming a specific candidate', () => {
  it('the dry-run reports BOTH candidates by field_id, and override picks the SECONDARY one', async () => {
    // Copying a Note into Contacts: Notes has ONE relation to Companies, but
    // Contacts has TWO ("Primary Company" and "Secondary Company") — the
    // genuinely ambiguous shape (several equally valid destinations).
    const noteRec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records`, { values: {} })
    ).json();
    const noteCompanyFieldId = await fieldIdFor(notesId, 'company');
    await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${notesId}/records/${noteRec.id}/links/${noteCompanyFieldId}`, {
      record_ids: [globexId],
    });

    const dry2 = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records/copy`, {
      record_ids: [noteRec.id],
      target_database_id: contactsId,
      dry_run: true,
    });
    expect(dry2.statusCode, dry2.body).toBe(201);
    const ambiguousPlan = dry2.json().plans.find((p: { sourceKey: string }) => p.sourceKey === 'company');
    expect(ambiguousPlan.state).toBe('blocking');
    expect(ambiguousPlan.ambiguousWith).toHaveLength(2);
    const byName = new Map(ambiguousPlan.ambiguousWith.map((c: { display_name: string; field_id: string }) => [c.display_name, c.field_id]));
    expect(byName.has('Primary Company')).toBe(true);
    expect(byName.has('Secondary Company')).toBe(true);
    const secondaryFieldId = byName.get('Secondary Company');

    const commit = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records/copy`, {
      record_ids: [noteRec.id],
      target_database_id: contactsId,
      override: { company: secondaryFieldId },
      dry_run: false,
    });
    expect(commit.statusCode, commit.body).toBe(201);
    const created = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${contactsId}/records/${commit.json().created[0]}`)
    ).json();
    // Linked via SECONDARY, never primary.
    expect((created.values[contactsCompanySecondaryApi] ?? []).map((c: { id: string }) => c.id)).toEqual([globexId]);
    expect(created.values[contactsCompanyPrimaryApi] ?? []).toEqual([]);
  });

  async function fieldIdFor(databaseId: string, apiName: string): Promise<string> {
    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${databaseId}`);
    return detail.json().fields.find((f: { apiName: string }) => f.apiName === apiName).id;
  }
});

describe('#605 — an invalid override is refused, never silently ignored', () => {
  it('an override naming a nonexistent destination field id reports "blocking" (with a clear reason) in the dry-run, and refuses the commit', async () => {
    const rec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records`, { values: { [notesTitleFieldApi]: 'x' } })
    ).json();
    const badOverride = {
      [notesTitleFieldApi]: '00000000-0000-0000-0000-000000000000',
      company: await destFieldId(contactsId, contactsCompanyPrimaryApi), // resolve the unrelated ambiguity
    };

    const dry = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      override: badOverride,
      dry_run: true,
    });
    expect(dry.statusCode, dry.body).toBe(201);
    const plan = dry.json().plans.find((p: { sourceKey: string }) => p.sourceKey === notesTitleFieldApi);
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toMatch(/does not exist/i);

    const before = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${contactsId}/records`)).json().data.length;
    const commit = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${notesId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: contactsId,
      override: badOverride,
      dry_run: false,
    });
    expect(commit.statusCode, commit.body).toBe(422);
    // Refused, not created — same "refuse, don't drop" guarantee every other
    // blocking path already has.
    const after = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${contactsId}/records`)).json().data.length;
    expect(after).toBe(before);
  });

  async function destFieldId(databaseId: string, apiName: string): Promise<string> {
    const detail = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${databaseId}`);
    return detail.json().fields.find((f: { apiName: string }) => f.apiName === apiName).id;
  }
});

describe('#605 MUST KEEP WORKING: unchanged auto-match/skip behavior when no override is given', () => {
  it('a field with a genuine name match still auto-maps with no override at all', async () => {
    const rec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${contactsId}/records`, { values: { [contactsBioApi]: 'unchanged path' } })
    ).json();
    const dup = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id, name: 'Contacts Clone' })).json();
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dup.id}/fields`, { display_name: 'Bio', type: 'text' });

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${contactsId}/records/copy`, {
      record_ids: [rec.id],
      target_database_id: dup.id,
      dry_run: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dup.id}/records/${res.json().created[0]}`)).json();
    expect(created.values['bio']).toBe('unchanged path');
  });
});
