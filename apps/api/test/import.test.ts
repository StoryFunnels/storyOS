import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let projectsId: string;
let clientsId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

/** Build a multipart body by hand (fastify inject-friendly). */
function multipart(fields: Record<string, string>, csv: string) {
  const boundary = 'X-IMPORT-BOUNDARY';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
  );
  return {
    payload: parts.join(''),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const MESSY_CSV = [
  'Name;Budget;Kickoff;Urgent;Stage;Client',
  'Website refresh;12000;15.02.2026;yes;Discovery;Globex',
  'Brand audit;4 500;2026-03-01;no;Delivery;Initech',
  ';1;2026-01-01;no;Discovery;Globex',
  'App build;not-a-number;01.04.2026;yes;Discovery;Nowhere Co',
].join('\n');

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Importer');
  wsId = (await inject('POST', '/workspaces', { name: 'Import WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  projectsId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  clientsId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${clientsId}/records`, { values: { name: 'Globex' } });
  await inject('POST', `/workspaces/${wsId}/databases/${clientsId}/records`, { values: { name: 'Initech' } });
  await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsId, database_b_id: clientsId, cardinality: 'one_to_many', field_a_name: 'Client',
  });
});

afterAll(async () => {
  await app.close();
});

describe('CSV import (MN-052)', () => {
  it('bootstrap (no mapping) parses semicolons and infers types', async () => {
    const { payload, headers } = multipart({ mapping: '[]' }, MESSY_CSV);
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${projectsId}/import`, headers: { ...authed(admin.token), ...headers }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const inferred = Object.fromEntries(res.json().inferred.map((c: { column: string; type: string }) => [c.column, c.type]));
    expect(inferred['Budget']).toBe('text'); // half the sample is junk — inference is honest
    expect(inferred['Kickoff']).toBe('date');
    expect(inferred['Urgent']).toBe('checkbox');
    expect(inferred['Stage']).toBe('select');
  });

  it('dry run reports per-row warnings without writing', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json();
    const clientField = detail.fields.find((f: { displayName: string }) => f.displayName === 'Client');
    const mapping = JSON.stringify([
      { column: 'Name', to: { kind: 'title' } },
      { column: 'Budget', to: { kind: 'new', display_name: 'Budget', type: 'number' } },
      { column: 'Kickoff', to: { kind: 'new', display_name: 'Kickoff', type: 'date' } },
      { column: 'Urgent', to: { kind: 'new', display_name: 'Urgent', type: 'checkbox' } },
      { column: 'Stage', to: { kind: 'new', display_name: 'Stage', type: 'select' } },
      { column: 'Client', to: { kind: 'relation', field_id: clientField.id } },
    ]);
    const { payload, headers } = multipart({ mapping, dry_run: 'true' }, MESSY_CSV);
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${projectsId}/import`, headers: { ...authed(admin.token), ...headers }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.will_create).toBe(3); // one row skipped (empty title)
    const messages = body.warnings.map((w: { message: string }) => w.message).join(' | ');
    expect(messages).toContain('empty title');
    expect(messages).toContain('Nowhere Co');
    expect(body.sample[0].Budget).toBe(12000);
    // No records written
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}/records`)).json();
    expect(list.data).toHaveLength(0);
  });

  it('commit imports rows, creates fields, resolves relations by title', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json();
    const clientField = detail.fields.find((f: { displayName: string }) => f.displayName === 'Client');
    const mapping = JSON.stringify([
      { column: 'Name', to: { kind: 'title' } },
      { column: 'Budget', to: { kind: 'new', display_name: 'Budget', type: 'number' } },
      { column: 'Kickoff', to: { kind: 'new', display_name: 'Kickoff', type: 'date' } },
      { column: 'Stage', to: { kind: 'new', display_name: 'Stage', type: 'select' } },
      { column: 'Client', to: { kind: 'relation', field_id: clientField.id } },
    ]);
    const { payload, headers } = multipart({ mapping, dry_run: 'false' }, MESSY_CSV);
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${projectsId}/import`, headers: { ...authed(admin.token), ...headers }, payload });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().created).toBe(3);

    const list = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}/records?limit=50`)).json();
    const site = list.data.find((r: { title: string }) => r.title === 'Website refresh');
    expect(site.values.budget).toBe(12000);
    const audit = list.data.find((r: { title: string }) => r.title === 'Brand audit');
    expect(audit.values.budget).toBe(4500); // "4 500" normalized
    expect(site.values.kickoff).toBe('2026-02-15');
    expect(site.values.client?.[0]?.title).toBe('Globex');
    const stageDetail = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json();
    const stage = stageDetail.fields.find((f: { displayName: string }) => f.displayName === 'Stage');
    expect(stage.options.map((o: { label: string }) => o.label).sort()).toEqual(['Delivery', 'Discovery']);
  });
});
