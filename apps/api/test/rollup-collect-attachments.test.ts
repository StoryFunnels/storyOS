import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #234 — a "collect" rollup gathers an ATTACHMENT field across EVERY matching
 * related record (not one winner, unlike first/last), rendered as real
 * clickable/downloadable chips, not bare stored ids or filename text.
 *
 * MECHANISM (recorded on the ticket): a new rollup op, reusing `first`/last's
 * proof that rollup already accepts any target field type. The materialized
 * `computed_values` entry is the TOTAL attachment count (a real, sortable
 * number — "most files first" is meaningful) — the rich list itself is
 * resolved fresh at read time, same split `first`/`last` already makes
 * between a scalar sort key and the rich display value.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let projectsDb: string;
let tasksDb: string;
let taskFieldId: string; // relation field on Projects → Tasks (side b)
let filesFieldId: string; // attachment field on Tasks

const BOUNDARY = 'X-STORYOS-TEST-BOUNDARY';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function multipartBody(filename: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: image/png\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

const upload = (taskId: string, filename: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}/attachments?field=${filesFieldId}`,
    headers: { ...authed(admin.token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(filename, PNG),
  });

async function getProject(id: string) {
  return (await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${id}`)).json();
}

/** The recompute cascade is fire-and-forget (RollupInvalidationSubscriber,
 *  never awaited by the write that triggered it) — poll briefly rather than
 *  asserting immediately, same pattern records-query-rollup-sort.test.ts uses. */
async function pollUntilTitlesMatch(payload: Record<string, unknown>, expectedPrefix: string[]): Promise<string[]> {
  let titles: string[] = [];
  for (let i = 0; i < 40; i++) {
    const res = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records/query`, payload)).json();
    titles = res.data.map((r: { title: string }) => r.title);
    if (JSON.stringify(titles.slice(0, expectedPrefix.length)) === JSON.stringify(expectedPrefix)) return titles;
    await new Promise((r) => setTimeout(r, 50));
  }
  return titles; // let the assertion below fail with a readable diff
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Collect Rollup Owner');
  wsId = (await inject('POST', '/workspaces', { name: '234 WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  tasksDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  filesFieldId = (
    await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, { display_name: 'Files', type: 'attachment' })
  ).json().id;

  // side a (tasksDb) is the MANY real-world side but gets the SINGLE-valued
  // "Project" field (its one parent); side b (projectsDb) gets the MULTI-
  // valued "Tasks" field — same convention rollups.test.ts's Time Off/Members
  // relation already uses.
  await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: projectsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Project',
    field_b_name: 'Tasks',
  });
  const projectFields = (await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}`)).json().fields;
  taskFieldId = projectFields.find((f: { apiName: string }) => f.apiName === 'tasks').id;
});

afterAll(async () => {
  await app.close();
});

describe('#234 rollup collect (attachment fields)', () => {
  it('validates config: collect needs a target field, and it must be an attachment', async () => {
    const noTarget = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Broken', type: 'rollup', config: { relation_field_id: taskFieldId, op: 'collect' },
    });
    expect(noTarget.statusCode).toBe(422);

    const wrongType = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Broken2', type: 'rollup',
      config: { relation_field_id: taskFieldId, op: 'collect', target_field_api_name: 'name' },
    });
    expect(wrongType.statusCode).toBe(422);
    expect(wrongType.body).toContain('attachment');
  });

  it('collects files from EVERY linked task onto the parent, as real chips — and an empty relation is an empty list, not null', async () => {
    const field = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'All Files', type: 'rollup',
      config: { relation_field_id: taskFieldId, op: 'collect', target_field_api_name: 'files' },
    });
    expect(field.statusCode, field.body).toBe(201);

    const empty = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Empty Project' } })).json();
    const projectWithFiles = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Launch' } })).json();
    const taskA = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Design' } })).json();
    const taskB = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Build' } })).json();
    await inject('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectWithFiles.id}/links/${taskFieldId}`, {
      record_ids: [taskA.id, taskB.id],
    });

    expect((await upload(taskA.id, 'wireframe.png')).statusCode).toBe(201);
    expect((await upload(taskA.id, 'mockup.png')).statusCode).toBe(201);
    expect((await upload(taskB.id, 'build-log.png')).statusCode).toBe(201);

    const emptyProject = await getProject(empty.id);
    expect(emptyProject.values.all_files).toEqual([]);

    const launched = await getProject(projectWithFiles.id);
    const files = launched.values.all_files as Array<{ filename: string; mime: string; has_thumbnail: boolean }>;
    expect(files).toHaveLength(3);
    const names = files.map((f) => f.filename).sort();
    expect(names).toEqual(['build-log.png', 'mockup.png', 'wireframe.png']);
    // Real chips, not bare ids or filename text — same shape a native attachment field renders.
    for (const f of files) expect(f).toMatchObject({ mime: 'image/png', has_thumbnail: expect.any(Boolean) });
  });

  it('sortable/filterable by the materialized TOTAL count — "most files first" is a real, meaningful sort', async () => {
    const field = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'File Count', type: 'rollup',
      config: { relation_field_id: taskFieldId, op: 'collect', target_field_api_name: 'files' },
    });
    expect(field.statusCode, field.body).toBe(201);

    const light = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Light' } })).json();
    const heavy = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Heavy' } })).json();
    const taskLight = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'One file' } })).json();
    const taskHeavy = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Three files' } })).json();
    // Upload BEFORE linking: recomputation of the materialized count is driven
    // off the LINK event (invalidateRollupsForChange), which re-reads whatever
    // the child's attachment field holds AT THAT MOMENT. A later upload to an
    // ALREADY-linked task does not itself retrigger recompute — attachment
    // writes go straight to the DB (attachments.service.ts) and never pass
    // through the domain-event bus RollupInvalidationSubscriber listens on.
    // That's a real, pre-existing gap shared with pick-one's sort key against
    // an attachment target (flagged, not fixed, on ticket #234 — fixing the
    // general "attachment write emits no domain event" gap is its own,
    // broader ticket, not this one).
    await upload(taskLight.id, 'a.png');
    await upload(taskHeavy.id, 'b.png');
    await upload(taskHeavy.id, 'c.png');
    await upload(taskHeavy.id, 'd.png');
    await inject('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${light.id}/links/${taskFieldId}`, { record_ids: [taskLight.id] });
    await inject('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${heavy.id}/links/${taskFieldId}`, { record_ids: [taskHeavy.id] });

    // Scoped to just these two records — other projects from earlier tests in
    // this file share the same database, so an unscoped sort/order would be
    // sensitive to their counts too.
    const order = await pollUntilTitlesMatch(
      {
        filter: { or: [{ field: 'name', op: 'eq', value: 'Light' }, { field: 'name', op: 'eq', value: 'Heavy' }] },
        sorts: [{ field: 'file_count', direction: 'desc' }],
      },
      ['Heavy', 'Light'],
    );
    expect(order).toEqual(['Heavy', 'Light']);
  });

  it('rejects writes to a collect rollup value', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, {
      values: { name: 'Cheater', all_files: [{ id: 'x' }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('respects an optional filter on the rollup — only matching tasks contribute their files', async () => {
    const doneField = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, {
      display_name: 'Done', type: 'checkbox',
    });
    const doneApiName = doneField.json().apiName;
    const field = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Done Files', type: 'rollup',
      config: {
        relation_field_id: taskFieldId,
        op: 'collect',
        target_field_api_name: 'files',
        filter: { field: doneApiName, op: 'eq', value: true },
      },
    });
    expect(field.statusCode, field.body).toBe(201);

    const project = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Filtered' } })).json();
    const doneTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Shipped', [doneApiName]: true } })).json();
    const openTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'In flight' } })).json();
    await inject('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${project.id}/links/${taskFieldId}`, {
      record_ids: [doneTask.id, openTask.id],
    });
    await upload(doneTask.id, 'shipped-asset.png');
    await upload(openTask.id, 'wip-asset.png');

    const result = await getProject(project.id);
    const files = result.values.done_files as Array<{ filename: string }>;
    expect(files.map((f) => f.filename)).toEqual(['shipped-asset.png']);
  });
});
