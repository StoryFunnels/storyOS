import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { activityEvents } from '../src/db/schema';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let clientsDb: string;
let projectsDb: string;
let relationId: string;
let projectField: { id: string; api_name: string }; // on Projects, points at Clients
let clientField: { id: string; api_name: string }; // on Clients, collects Projects
let acme: string;
let globex: string;
let siteRedesign: string;
let seoAudit: string;
const { db, pool } = connectTestDb();

const H = () => authed(admin.token);

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: H(), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Relator');
  const ws = await inject('POST', '/workspaces', { name: 'Relations WS' });
  wsId = ws.json().id;
  const spaces = await inject('GET', `/workspaces/${wsId}/spaces`);
  const spaceId = spaces.json()[0].id;

  clientsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;

  acme = (await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Acme' } })).json().id;
  globex = (await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Globex' } })).json().id;
  siteRedesign = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Site redesign' } })).json().id;
  seoAudit = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'SEO audit' } })).json().id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('relations backend (MN-018)', () => {
  it('creates a relation with paired fields on both databases', async () => {
    // A = Projects (many side): each project belongs to one client.
    const res = await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: projectsDb,
      database_b_id: clientsDb,
      cardinality: 'one_to_many',
      field_a_name: 'Client',
      field_b_name: 'Projects',
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    relationId = body.id;
    projectField = body.field_a;
    clientField = body.field_b;
    expect(projectField.api_name).toBe('client');
    expect(clientField.api_name).toBe('projects');

    const projectsIntrospection = await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}`);
    const relField = projectsIntrospection.json().fields.find((f: { type: string }) => f.type === 'relation');
    expect(relField.relation).toMatchObject({
      cardinality: 'one_to_many',
      side: 'a',
      target_database_id: clientsDb,
      target_database_name: 'Clients',
    });
  });

  it('links records and both sides see it (record reads embed chips)', async () => {
    const add = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${projectField.id}`,
      { record_ids: [acme] },
    );
    expect(add.statusCode, add.body).toBe(201);
    expect(add.json().data).toEqual([{ id: acme, title: 'Acme' }]);

    const inverse = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${clientsDb}/records/${acme}/links/${clientField.id}`,
    );
    expect(inverse.json().data).toEqual([{ id: siteRedesign, title: 'Site redesign' }]);

    const project = await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}`);
    expect(project.json().values.client).toEqual([{ id: acme, title: 'Acme' }]);

    const clientRead = await inject('GET', `/workspaces/${wsId}/databases/${clientsDb}/records/${acme}`);
    expect(clientRead.json().values.projects).toEqual([{ id: siteRedesign, title: 'Site redesign' }]);
  });

  it('writes relation.linked activity on both records', async () => {
    for (const recordId of [siteRedesign, acme]) {
      const events = await db.query.activityEvents.findMany({
        where: eq(activityEvents.recordId, recordId),
      });
      expect(events.some((e) => e.type === 'relation.linked')).toBe(true);
    }
  });

  it('enforces one-to-many: 409 on second link, replace switches cleanly', async () => {
    const second = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${projectField.id}`,
      { record_ids: [globex] },
    );
    expect(second.statusCode).toBe(409);

    const replace = await inject(
      'PUT',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${projectField.id}`,
      { record_ids: [globex] },
    );
    expect(replace.statusCode).toBe(200);
    expect(replace.json().data).toEqual([{ id: globex, title: 'Globex' }]);
  });

  it('filters records by relation: has / is_empty in both directions', async () => {
    const withGlobex = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records/query`, {
      filter: { field: 'client', op: 'has', value: [globex] },
    });
    expect(withGlobex.json().data.map((r: { title: string }) => r.title)).toEqual(['Site redesign']);

    const orphanProjects = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records/query`, {
      filter: { field: 'client', op: 'is_empty' },
    });
    expect(orphanProjects.json().data.map((r: { title: string }) => r.title)).toEqual(['SEO audit']);

    const clientsWithProjects = await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records/query`, {
      filter: { field: 'projects', op: 'not_empty' },
    });
    expect(clientsWithProjects.json().data.map((r: { title: string }) => r.title)).toEqual(['Globex']);
  });

  it('unlink removes both directions', async () => {
    const remove = await inject(
      'DELETE',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${projectField.id}`,
      { record_ids: [globex] },
    );
    expect(remove.json().data).toEqual([]);
    const inverse = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${clientsDb}/records/${globex}/links/${clientField.id}`,
    );
    expect(inverse.json().data).toEqual([]);
  });

  it('supports self-relations (Task blocks Task)', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: projectsDb,
      database_b_id: projectsDb,
      cardinality: 'many_to_many',
      field_a_name: 'Blocks',
      field_b_name: 'Blocked by',
    });
    expect(res.statusCode, res.body).toBe(201);
    const blocksField = res.json().field_a;

    const link = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${blocksField.id}`,
      { record_ids: [seoAudit] },
    );
    expect(link.json().data).toEqual([{ id: seoAudit, title: 'SEO audit' }]);

    const inverse = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${seoAudit}/links/${res.json().field_b.id}`,
    );
    expect(inverse.json().data).toEqual([{ id: siteRedesign, title: 'Site redesign' }]);

    await inject('DELETE', `/workspaces/${wsId}/relations/${res.json().id}`, { confirm: true });
  });

  it('deleting a relation removes both fields and all links', async () => {
    // re-link first so there is a link to cascade
    await inject(
      'PUT',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${projectField.id}`,
      { record_ids: [acme] },
    );
    const del = await inject('DELETE', `/workspaces/${wsId}/relations/${relationId}`, { confirm: true });
    expect(del.statusCode).toBe(200);

    const projects = await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}`);
    expect(projects.json().fields.find((f: { id: string }) => f.id === projectField.id)).toBeUndefined();
    const clients = await inject('GET', `/workspaces/${wsId}/databases/${clientsDb}`);
    expect(clients.json().fields.find((f: { id: string }) => f.id === clientField.id)).toBeUndefined();
  });

  it('database delete is guarded by inbound relations until severed', async () => {
    const rel = await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: projectsDb,
      database_b_id: clientsDb,
      cardinality: 'many_to_many',
    });
    expect(rel.statusCode).toBe(201);

    const blocked = await inject('DELETE', `/workspaces/${wsId}/databases/${clientsDb}`, {
      confirm: 'Clients',
    });
    expect(blocked.statusCode).toBe(409);

    const severed = await inject('DELETE', `/workspaces/${wsId}/databases/${clientsDb}`, {
      confirm: 'Clients',
      sever_relations: true,
    });
    expect(severed.statusCode).toBe(200);
    expect(severed.json().severed_relations).toBe(1);

    // The paired field on Projects is gone too.
    const projects = await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}`);
    expect(projects.json().fields.filter((f: { type: string }) => f.type === 'relation')).toEqual([]);
  });
});
