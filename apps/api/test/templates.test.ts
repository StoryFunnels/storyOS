import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Founder');
  wsId = (await inject('POST', '/workspaces', { name: 'Template WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('templates (MN-032)', () => {
  it('lists available templates', async () => {
    const res = await inject('GET', '/templates');
    expect(res.json().data.map((t: { slug: string }) => t.slug)).toEqual([
      'client-work',
      'content-pipeline',
    ]);
  });

  it('applies Client Projects & Tasks: space, 3 dbs, 2 relations, views, samples, in <5s', async () => {
    const start = performance.now();
    const res = await inject('POST', `/workspaces/${wsId}/templates/client-work/apply`);
    const elapsed = performance.now() - start;
    expect(res.statusCodes ?? res.statusCode, res.body).toBe(201);
    expect(elapsed).toBeLessThan(5000);
    expect(res.json().sample_records).toBe(9);

    const dbs = await inject('GET', `/workspaces/${wsId}/databases`);
    const names = dbs.json().map((d: { name: string }) => d.name).sort();
    expect(names).toEqual(['Clients', 'Projects', 'Tasks']);

    const tasksDb = dbs.json().find((d: { name: string }) => d.name === 'Tasks');
    const detail = await inject('GET', `/workspaces/${wsId}/databases/${tasksDb.id}`);
    const fieldTypes = detail.json().fields.map((f: { type: string }) => f.type);
    expect(fieldTypes).toContain('relation');
    expect(detail.json().views.map((v: { name: string }) => v.name)).toContain('Task Board');

    // Sample records exist and are linked
    const query = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb.id}/records/query`, {
      filter: { field: 'project', op: 'not_empty' },
    });
    expect(query.json().data.length).toBeGreaterThanOrEqual(5);
    const withChips = query.json().data[0];
    expect(withChips.values.project[0].title).toContain('sample');
  });

  it('removes exactly the sample data', async () => {
    const res = await inject('DELETE', `/workspaces/${wsId}/templates/sample-data`);
    expect(res.json().removed).toBe(9);

    const dbs = await inject('GET', `/workspaces/${wsId}/databases`);
    const tasksDb = dbs.json().find((d: { name: string }) => d.name === 'Tasks');
    const list = await inject('GET', `/workspaces/${wsId}/databases/${tasksDb.id}/records`);
    expect(list.json().data).toHaveLength(0);
  });

  it('applies the content pipeline template into the same workspace (F3)', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/templates/content-pipeline/apply`);
    expect(res.statusCode, res.body).toBe(201);
    const spaces = await inject('GET', `/workspaces/${wsId}/spaces`);
    expect(spaces.json().map((s: { name: string }) => s.name)).toContain('Content');
  });
});
