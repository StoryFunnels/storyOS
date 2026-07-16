import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #140: mentions feed backlinks from EVERY surface a record speaks through —
 * its document (covered by mentions.test.ts), its rich_text FIELD values, and
 * its COMMENTS' #record segments. One sync owns the whole set, so surfaces
 * never clobber each other.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let tasks: string;
let projects: string;
let notesApi: string; // rich_text field on Tasks
let source: string;
let target: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(owner.token),
    payload: payload as never,
  });
}

const backlinks = async () =>
  (
    await inject('GET', `/workspaces/${ws}/databases/${projects}/records/${target}/backlinks`)
  ).json().data as Array<{ id: string }>;

/** Wait for the fire-and-forget sync to land. */
async function eventually(predicate: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const mentionBlock = (recordId: string) => [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'refs ', styles: {} },
      { type: 'mention', props: { kind: 'record', id: recordId, label: 'Target' } },
    ],
  },
];

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  ws = (await inject('POST', '/workspaces', { name: 'Sources WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  projects = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Projects' })).json().id;
  notesApi = (
    await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Notes', type: 'rich_text' })
  ).json().apiName;
  source = (await inject('POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: {} })).json().id;
  target = (await inject('POST', `/workspaces/${ws}/databases/${projects}/records`, { values: {} })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('backlinks from rich_text field values (#140)', () => {
  it('a #mention written into a rich_text field creates a backlink', async () => {
    const res = await inject('PATCH', `/workspaces/${ws}/databases/${tasks}/records/${source}`, {
      values: { [notesApi]: mentionBlock(target) },
    });
    expect(res.statusCode).toBe(200);
    expect(
      await eventually(async () => (await backlinks()).some((b) => b.id === source)),
      'rich_text mention produced a backlink',
    ).toBe(true);
  });

  it('clearing the field drops the backlink', async () => {
    const res = await inject('PATCH', `/workspaces/${ws}/databases/${tasks}/records/${source}`, {
      values: { [notesApi]: [{ type: 'paragraph', content: [] }] },
    });
    expect(res.statusCode).toBe(200);
    expect(
      await eventually(async () => !(await backlinks()).some((b) => b.id === source)),
      'backlink removed after the mention was deleted',
    ).toBe(true);
  });
});

describe('backlinks from comment #record segments (#140)', () => {
  let commentId: string;

  it('a #record segment in a comment creates a backlink', async () => {
    const res = await inject('POST', `/workspaces/${ws}/databases/${tasks}/records/${source}/comments`, {
      body: [
        { type: 'text', text: 'see ' },
        { type: 'record', record_id: target, database_id: projects },
      ],
    });
    expect(res.statusCode).toBe(201);
    commentId = res.json().id;
    expect(
      await eventually(async () => (await backlinks()).some((b) => b.id === source)),
      'comment mention produced a backlink',
    ).toBe(true);
  });

  it('deleting the comment drops the backlink', async () => {
    const res = await inject(
      'DELETE',
      `/workspaces/${ws}/databases/${tasks}/records/${source}/comments/${commentId}`,
    );
    expect(res.statusCode).toBe(200);
    expect(
      await eventually(async () => !(await backlinks()).some((b) => b.id === source)),
      'backlink removed with the comment',
    ).toBe(true);
  });

  it('a stale/foreign record id in a comment is refused', async () => {
    const res = await inject('POST', `/workspaces/${ws}/databases/${tasks}/records/${source}/comments`, {
      body: [{ type: 'record', record_id: '00000000-0000-0000-0000-000000000001', database_id: projects }],
    });
    expect(res.statusCode).toBe(422);
  });
});
