import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-080: create_record/update_record accept relation targets inline, so a seeding
 * job doesn't need a second link_records round-trip per record — and a bad target
 * fails the whole write rather than leaving a record behind unlinked.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let tasksDb: string;
let projectsDb: string;
let projectField: string; // Tasks -> Projects, one_to_many, side a (single)
let tagsField: string; // Tasks <-> Tags, many_to_many
let tagsDb: string;
let projectOne: { id: string; number: number };
let projectTwo: { id: string; number: number };

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
  admin = await signUpUser(app, 'Linker');
  wsId = (await inject('POST', '/workspaces', { name: 'Rel WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  tagsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tags' })).json().id;

  const rel = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: projectsDb,
    cardinality: 'one_to_many',
    name_a: 'Project',
    name_b: 'Tasks',
  });
  projectField = rel.json().field_a?.id ?? rel.json().fieldA?.id;

  const m2m = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: tagsDb,
    cardinality: 'many_to_many',
    name_a: 'Tags',
    name_b: 'Tasks',
  });
  tagsField = m2m.json().field_a?.id ?? m2m.json().fieldA?.id;

  const p1 = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Apollo' } });
  const p2 = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Zephyr' } });
  projectOne = { id: p1.json().id, number: p1.json().number };
  projectTwo = { id: p2.json().id, number: p2.json().number };
});

afterAll(async () => {
  await app.close();
});

/** The api_name the relation field got — derived, so the test doesn't guess. */
async function relationApiName(fieldId: string, dbId: string): Promise<string> {
  const db = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  return db.fields.find((f: { id: string }) => f.id === fieldId).apiName;
}

describe('create_record with relation values (MN-080)', () => {
  it('links by record id in the same write — no second call', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Ship the thing', [project]: [projectOne.id] },
    });
    expect(res.statusCode).toBe(201);

    const fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${res.json().id}`)).json();
    expect(fetched.values[project]).toEqual([expect.objectContaining({ title: 'Apollo' })]);
  });

  it('links by public number — the friendly form for agents', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'By number', [project]: [projectTwo.number] },
    });
    expect(res.statusCode).toBe(201);
    const fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${res.json().id}`)).json();
    expect(fetched.values[project]).toEqual([expect.objectContaining({ title: 'Zephyr' })]);
  });

  it('links many targets on a many-to-many', async () => {
    const tags = await relationApiName(tagsField, tasksDb);
    const t1 = (await inject('POST', `/workspaces/${wsId}/databases/${tagsDb}/records`, { values: { name: 'urgent' } })).json();
    const t2 = (await inject('POST', `/workspaces/${wsId}/databases/${tagsDb}/records`, { values: { name: 'backend' } })).json();

    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Tagged', [tags]: [t1.id, t2.number] },
    });
    expect(res.statusCode).toBe(201);
    const fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${res.json().id}`)).json();
    expect(fetched.values[tags].map((c: { title: string }) => c.title).sort()).toEqual(['backend', 'urgent']);
  });

  it('is ATOMIC — a bad target leaves no record behind', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const before = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records/query`, { limit: 200 })).json().data.length;

    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Should never exist', [project]: [999999] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].message).toMatch(/no record "999999" in the target database/);

    const after = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records/query`, { limit: 200 })).json().data;
    expect(after.length, 'the failed create must not have inserted a row').toBe(before);
    expect(after.some((r: { title: string }) => r.title === 'Should never exist')).toBe(false);
  });

  it('rejects a target from the wrong database', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const tag = (await inject('POST', `/workspaces/${wsId}/databases/${tagsDb}/records`, { values: { name: 'not a project' } })).json();
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Wrong target db', [project]: [tag.id] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses two targets on the single side of a one-to-many', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Two parents', [project]: [projectOne.id, projectTwo.id] },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toMatch(/only one target/);
  });

  it('rejects a non-array relation value with a useful message', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Bad shape', [project]: projectOne.id },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toMatch(/array of record ids or numbers/);
  });

  /**
   * #278: a public number sent as a JSON string (e.g. { project: ["1"] }, which is
   * exactly what an agent following the tool's own docs — "target record numbers or
   * ids" — can produce) used to fall through to a raw uuid-column lookup and crash
   * with an unhandled Postgres syntax error, surfaced to the caller as a bare 500.
   */
  it('links by a public number sent as a string, not just a JS number (#278)', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'By stringified number', [project]: [String(projectOne.number)] },
    });
    expect(res.statusCode).toBe(201);
    const fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${res.json().id}`)).json();
    expect(fetched.values[project]).toEqual([expect.objectContaining({ title: 'Apollo' })]);
  });

  it('names the field and target for a malformed relation value instead of a bare 500 (#278)', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Garbage target', [project]: ['not-a-real-id'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe(`values.${project}`);
    expect(res.json().error.details[0].message).toMatch(/not-a-real-id/);
  });
});

describe('update_record with relation values (MN-080)', () => {
  it('re-points a link, and clears it with an empty array', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
        values: { name: 'Re-pointable', [project]: [projectOne.id] },
      })
    ).json();

    await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`, {
      values: { [project]: [projectTwo.id] },
    });
    let fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`)).json();
    expect(fetched.values[project]).toEqual([expect.objectContaining({ title: 'Zephyr' })]);

    await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`, {
      values: { [project]: [] },
    });
    fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`)).json();
    expect(fetched.values[project] ?? []).toEqual([]);
  });

  it('a relation-only update still applies (no value diff to carry it)', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Links only' } })
    ).json();
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`, {
      values: { [project]: [projectOne.id] },
    });
    expect(res.statusCode).toBe(200);
    const fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`)).json();
    expect(fetched.values[project]).toEqual([expect.objectContaining({ title: 'Apollo' })]);
  });

  it('leaves untouched relations alone', async () => {
    const project = await relationApiName(projectField, tasksDb);
    const tags = await relationApiName(tagsField, tasksDb);
    const tag = (await inject('POST', `/workspaces/${wsId}/databases/${tagsDb}/records`, { values: { name: 'keepme' } })).json();
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
        values: { name: 'Two relations', [project]: [projectOne.id], [tags]: [tag.id] },
      })
    ).json();

    await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`, {
      values: { [project]: [projectTwo.id] },
    });
    const fetched = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${rec.id}`)).json();
    expect(fetched.values[tags], 'tags were not named, so they must survive').toEqual([
      expect.objectContaining({ title: 'keepme' }),
    ]);
  });
});
