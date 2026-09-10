import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #671 — an attachment upload/delete now emits the same `record_updated`
 * domain event an ordinary field write already does, so a rollup targeting
 * that field recomputes WITHOUT needing the relation to be re-linked.
 *
 * This specifically exercises the MATERIALIZED sort/filter value
 * (`computed_values`), not the field's displayed value — the rich list
 * (`attachCollectRollup`) always re-queries live and was never stale, so
 * checking it would pass even without this fix. Filtering by the exact
 * materialized count via `eq` sidesteps any sort-tie-break ambiguity.
 * Before this fix, uploading/removing a file on an ALREADY-linked task left
 * the parent's materialized count stuck until something else (a link
 * change) triggered recompute — `rollup-collect-attachments.test.ts`
 * sidesteps this exact gap deliberately by uploading BEFORE linking; this
 * file tests the gap directly.
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

/**
 * Polls until the record's MATERIALIZED `file_count` exactly equals `count`,
 * via a direct `eq` filter (no sort/tie-break ambiguity). The cascade is
 * fire-and-forget, mirroring records-query-rollup-sort.test.ts's own pattern.
 */
async function pollUntilMaterializedCount(recordId: string, count: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const res = (
      await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records/query`, {
        filter: { field: 'file_count', op: 'eq', value: count },
      })
    ).json();
    if ((res.data as Array<{ id: string }>).some((r) => r.id === recordId)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Attachment Invalidation Owner');
  wsId = (await inject('POST', '/workspaces', { name: '671 WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  tasksDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  filesFieldId = (
    await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, { display_name: 'Files', type: 'attachment' })
  ).json().id;

  await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: projectsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Project',
    field_b_name: 'Tasks',
  });
  const projectFields = (await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}`)).json().fields;
  taskFieldId = projectFields.find((f: { apiName: string }) => f.apiName === 'tasks').id;

  await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
    display_name: 'File Count', type: 'rollup',
    config: { relation_field_id: taskFieldId, op: 'collect', target_field_api_name: 'files' },
  });
});

afterAll(async () => {
  await app.close();
});

describe('#671 attachment writes invalidate rollups on an ALREADY-linked record', () => {
  it('uploading files to an already-linked task advances the materialized count, without re-linking', async () => {
    const project = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Uploaded' } })).json();
    const task = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Task' } })).json();
    await inject('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${project.id}/links/${taskFieldId}`, { record_ids: [task.id] });
    expect(await pollUntilMaterializedCount(project.id, 0)).toBe(true);

    // Upload happens AFTER linking, with no further link/relation change —
    // exactly the write path that used to leave the materialized count stuck.
    expect((await upload(task.id, 'one.png')).statusCode).toBe(201);
    expect(await pollUntilMaterializedCount(project.id, 1)).toBe(true);

    expect((await upload(task.id, 'two.png')).statusCode).toBe(201);
    expect(await pollUntilMaterializedCount(project.id, 2)).toBe(true);
  });

  it('removing a file from an already-linked task brings the materialized count back down', async () => {
    const project = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'ThenEmptied' } })).json();
    const task = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Task' } })).json();
    await inject('PUT', `/workspaces/${wsId}/databases/${projectsDb}/records/${project.id}/links/${taskFieldId}`, { record_ids: [task.id] });
    const uploaded = await upload(task.id, 'doomed.png');
    expect(await pollUntilMaterializedCount(project.id, 1)).toBe(true);

    const removed = await inject(
      'DELETE',
      `/workspaces/${wsId}/databases/${tasksDb}/records/${task.id}/attachments/${uploaded.json().id}`,
    );
    expect(removed.statusCode).toBe(200);
    expect(await pollUntilMaterializedCount(project.id, 0)).toBe(true);
  });
});
