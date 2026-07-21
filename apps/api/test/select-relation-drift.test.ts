import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-286: a database can have both a `select` field (a quick label, e.g.
 * "Project") and a `relation` field pointing at another database that means
 * the same grouping (e.g. an `epic` relation to Projects). Nothing keeps
 * them synced — reproduces the exact drift found in storyos/issues: an issue
 * carrying project="MCP API" (select) with no epic relation link to the
 * "MCP API" Project record.
 */
let app: NestFastifyApplication;
let owner: { token: string; id: string };
let ws: string;
let projects: string;
let issues: string;
let relationId: string;
let issuesRelationField: string; // relation field on Issues (points at Projects), i.e. "epic"
let projectsRelationField: string; // reverse relation field on Projects, i.e. "issues"
let issuesProjectSelectApi: string;
let mcpApiOptionId: string;
let mcpApiProjectId: string;

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

async function addIssue(title: string, projectOptionId?: string): Promise<string> {
  const res = await inject('POST', `/workspaces/${ws}/databases/${issues}/records`, {
    values: { name: title, ...(projectOptionId ? { [issuesProjectSelectApi]: projectOptionId } : {}) },
  });
  expect(res.statusCode, `add issue ${title}`).toBe(201);
  return res.json().id;
}

async function linksFor(db: string, rec: string, field: string): Promise<string[]> {
  const res = await inject('GET', `/workspaces/${ws}/databases/${db}/records/${rec}/links/${field}`);
  expect(res.statusCode).toBe(200);
  return res.json().data.map((r: { id: string }) => r.id);
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  ws = (await inject('POST', '/workspaces', { name: 'Drift WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  projects = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Projects' })).json().id;
  issues = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Issues' })).json().id;

  const selectField = await inject('POST', `/workspaces/${ws}/databases/${issues}/fields`, {
    display_name: 'Project',
    type: 'select',
    options: [{ label: 'MCP API' }, { label: 'Databases & Fields' }],
  });
  expect(selectField.statusCode).toBe(201);
  issuesProjectSelectApi = selectField.json().apiName;
  mcpApiOptionId = selectField.json().options.find((o: { label: string }) => o.label === 'MCP API').id;

  // Issues is the "many" side (each issue has at most one epic) — side A.
  const rel = await inject('POST', `/workspaces/${ws}/relations`, {
    database_a_id: issues,
    database_b_id: projects,
    cardinality: 'one_to_many',
    field_a_name: 'Epic',
    field_b_name: 'Issues',
  });
  expect(rel.statusCode).toBe(201);
  relationId = rel.json().id;
  issuesRelationField = rel.json().field_a.id;
  projectsRelationField = rel.json().field_b.id;

  const project = await inject('POST', `/workspaces/${ws}/databases/${projects}/records`, {
    values: { name: 'MCP API' },
  });
  expect(project.statusCode).toBe(201);
  mcpApiProjectId = project.json().id;
});

afterAll(async () => {
  await app.close();
});

describe('select-relation drift check (MN-286)', () => {
  it('reports no drift when nothing carries the matching select label', async () => {
    const res = await inject('GET', `/workspaces/${ws}/relations/${relationId}/select-drift?record_id=${mcpApiProjectId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().drift).toBeNull();
  });

  it('detects issues with project="MCP API" (select) but no epic link to the Project record', async () => {
    const linkedCorrectly = await addIssue('Linked correctly', mcpApiOptionId);
    await inject('POST', `/workspaces/${ws}/databases/${issues}/records/${linkedCorrectly}/links/${issuesRelationField}`, {
      record_ids: [mcpApiProjectId],
    });

    const drifted1 = await addIssue('Drifted issue 1', mcpApiOptionId); // select set, no link — the bug
    const drifted2 = await addIssue('Drifted issue 2', mcpApiOptionId);
    await addIssue('Unrelated issue'); // no select value at all — must never show up

    const res = await inject('GET', `/workspaces/${ws}/relations/${relationId}/select-drift?record_id=${mcpApiProjectId}`);
    expect(res.statusCode).toBe(200);
    const drift = res.json().drift;
    expect(drift).not.toBeNull();
    expect(drift.select_field.api_name).toBe(issuesProjectSelectApi);
    expect(drift.matched_option.label).toBe('MCP API');
    expect(drift.missing_count).toBe(2);
    const missingIds = drift.missing_records.map((r: { id: string }) => r.id);
    expect(missingIds).toEqual(expect.arrayContaining([drifted1, drifted2]));
    expect(missingIds).not.toContain(linkedCorrectly);
  });

  it('reconciles drift by bulk-linking every matching record, and is idempotent', async () => {
    const before = await inject('GET', `/workspaces/${ws}/relations/${relationId}/select-drift?record_id=${mcpApiProjectId}`);
    expect(before.json().drift.missing_count).toBe(2);

    const reconcile = await inject('POST', `/workspaces/${ws}/relations/${relationId}/select-drift/reconcile`, {
      record_id: mcpApiProjectId,
    });
    expect(reconcile.statusCode).toBe(201);
    expect(reconcile.json().linked).toBe(2);
    expect(reconcile.json().failed).toEqual([]);

    const after = await inject('GET', `/workspaces/${ws}/relations/${relationId}/select-drift?record_id=${mcpApiProjectId}`);
    expect(after.json().drift).toBeNull();

    // Reconciling again links nothing new (already resolved).
    const again = await inject('POST', `/workspaces/${ws}/relations/${relationId}/select-drift/reconcile`, {
      record_id: mcpApiProjectId,
    });
    expect(again.json().linked).toBe(0);

    // Every linked issue is now visible via the Projects-side reverse field.
    const linkedToProject = await linksFor(projects, mcpApiProjectId, projectsRelationField);
    expect(linkedToProject.length).toBeGreaterThanOrEqual(3); // linked-correctly + the 2 reconciled
  });

  it('404s for a record that belongs to neither side of the relation', async () => {
    const other = (await inject('POST', `/workspaces/${ws}/databases`, {
      space_id: (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id,
      name: 'Unrelated',
    })).json().id;
    const rec = (await inject('POST', `/workspaces/${ws}/databases/${other}/records`, { values: { name: 'X' } })).json().id;
    const res = await inject('GET', `/workspaces/${ws}/relations/${relationId}/select-drift?record_id=${rec}`);
    expect(res.statusCode).toBe(404);
  });
});
