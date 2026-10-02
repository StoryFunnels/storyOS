import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #435 AC2 (reinstated under #612): when a copy is blocked on a field, say HOW
 * MANY of the selected records are affected. "Has a value" versus "has a value
 * in 12 of 50 selected" is the difference between a warning you cannot act on
 * and one you can — 12 of 50 means fix twelve records, 50 of 50 means choose a
 * different field.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let leadsId: string;
let contactsId: string;
let companiesId: string;
let acmeId: string;
let priorityApi: string;
let priorityOptionId: string;
let leadCompanyApi: string;
let leadIds: string[] = [];

function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

async function dryRun(recordIds: string[], extra: Record<string, unknown> = {}) {
  const res = await as('POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
    record_ids: recordIds,
    target_database_id: contactsId,
    dry_run: true,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'BlockCounts');
  wsId = (await as('POST', '/workspaces', { name: 'Block Counts WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  companiesId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Companies' })).json().id;
  acmeId = (await as('POST', `/workspaces/${wsId}/databases/${companiesId}/records`, { values: { name: 'Acme' } })).json().id;
  leadsId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
  contactsId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Contacts' })).json().id;

  // Priority exists ONLY on the source: a value in it has nowhere to go.
  const priority = (await as('POST', `/workspaces/${wsId}/databases/${leadsId}/fields`, {
    display_name: 'Priority', type: 'select', options: [{ label: 'Low' }, { label: 'High' }],
  })).json();
  priorityApi = priority.apiName;
  priorityOptionId = priority.options[0].id;

  // Company is a relation on the SOURCE only, so a link has nowhere to go either.
  leadCompanyApi = (await as('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: leadsId, database_b_id: companiesId, cardinality: 'one_to_many', field_a_name: 'Company',
  })).json().field_a.api_name;

  // Five leads. Priority on the first three; a Company link on the first two.
  const specs = [
    { name: 'L1', priority: true, company: true },
    { name: 'L2', priority: true, company: true },
    { name: 'L3', priority: true, company: false },
    { name: 'L4', priority: false, company: false },
    { name: 'L5', priority: false, company: false },
  ];
  for (const spec of specs) {
    const values: Record<string, unknown> = { name: spec.name };
    if (spec.priority) values[priorityApi] = priorityOptionId;
    if (spec.company) values[leadCompanyApi] = [acmeId];
    leadIds.push((await as('POST', `/workspaces/${wsId}/databases/${leadsId}/records`, { values })).json().id);
  }
});

afterAll(async () => {
  await app.close();
});

describe('copy-record blocking — "N of M selected" (#435 AC2)', () => {
  it('says how many of the selected records have a value in the blocking field', async () => {
    const body = await dryRun(leadIds);
    const plan = body.plans.find((p: { sourceKey: string }) => p.sourceKey === priorityApi);
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toContain('Affects 3 of 5 selected records.');
    // The same text must reach the blocking list a client reads, not just the plan.
    const block = body.blocking.find((b: { sourceKey: string }) => b.sourceKey === priorityApi);
    expect(block.message).toBe(plan.reason);
  });

  it('counts a relation field by the records that have a link, not by the links', async () => {
    const body = await dryRun(leadIds);
    const plan = body.plans.find((p: { sourceKey: string }) => p.sourceKey === leadCompanyApi);
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toContain('Affects 2 of 5 selected records.');
  });

  it('is per COPY: a selection that omits every affected record is not blocked at all', async () => {
    const body = await dryRun([leadIds[3]!, leadIds[4]!]);
    expect(body.blocking).toBeUndefined();
    const plan = body.plans.find((p: { sourceKey: string }) => p.sourceKey === priorityApi);
    expect(plan.state).toBe('skipped');
  });

  it('a single record keeps the original message — "1 of 1" would be noise', async () => {
    const body = await dryRun([leadIds[0]!]);
    const plan = body.plans.find((p: { sourceKey: string }) => p.sourceKey === priorityApi);
    expect(plan.state).toBe('blocking');
    expect(plan.reason).not.toContain('Affects');
    expect(plan.reason).toBe('"Priority" has a value and no matching field in the destination. Map it, or skip it explicitly.');
  });

  it('the refused commit is unchanged: it still names how many fields block (the counts live on the dry-run the dialog always runs first)', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${leadsId}/records/copy`, {
      record_ids: leadIds,
      target_database_id: contactsId,
      dry_run: false,
    });
    expect(res.statusCode).toBe(422);
    // The 422's `blocking` array is not forwarded to clients (copy-to-dialog.tsx documents
    // this), and Confirm is disabled while anything blocks — so the per-field counts are
    // asserted on the dry-run above, and this only guards that refusing still works.
    expect(res.json().error.message).toBe('Copy refused: 2 field(s) have no destination and were not skipped.');
  });

  it('skipping the field clears the block, so the count never strands a user', async () => {
    const body = await dryRun(leadIds, { skip: [priorityApi, leadCompanyApi] });
    expect(body.blocking).toBeUndefined();
  });
});
