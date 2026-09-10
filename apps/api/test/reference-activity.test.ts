import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #670 phase 2, piece 1 — a `#record` mention now emits a `reference.created`
 * activity event with real attribution (actor/source), and the database
 * activity feed (#240 phase 1) includes it alongside comments.
 *
 * The load-bearing property: `syncRecordMentions` DELETEs and RE-INSERTs the
 * whole mention set on every content save. Without a diff, every unrelated
 * re-save would emit a false "reference created" — these tests exist
 * specifically to prove that does NOT happen.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let tasksDb: string;
let projectsDb: string;
let source: { id: string };
let targetA: { id: string };
let targetB: { id: string };

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(owner.token), payload: payload as never });
}

async function putDoc(recordId: string, content: unknown, version: number) {
  return inject('PUT', `/workspaces/${ws}/databases/${tasksDb}/records/${recordId}/document`, {
    content,
    expected_version: version,
  });
}

const docMentioning = (...recordIds: string[]) => [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'see ', styles: {} },
      ...recordIds.map((id) => ({ type: 'mention', props: { kind: 'record', id, label: 'x' } })),
    ],
  },
];

async function referenceEvents() {
  const res = await inject('GET', `/workspaces/${ws}/databases/${tasksDb}/activity/comments`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as Array<{ type: string }>).filter((e) => e.type === 'reference.created');
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Reference Activity Owner');
  ws = (await inject('POST', '/workspaces', { name: '670 WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasksDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  projectsDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;

  source = (await inject('POST', `/workspaces/${ws}/databases/${tasksDb}/records`, { values: { name: 'Source task' } })).json();
  targetA = (await inject('POST', `/workspaces/${ws}/databases/${projectsDb}/records`, { values: { name: 'Target A' } })).json();
  targetB = (await inject('POST', `/workspaces/${ws}/databases/${projectsDb}/records`, { values: { name: 'Target B' } })).json();
});

afterAll(async () => {
  await app.close();
});

describe('#670 reference.created activity events', () => {
  it('a genuinely NEW mention produces exactly one reference.created event, attributed', async () => {
    expect((await putDoc(source.id, docMentioning(targetA.id), 0)).statusCode).toBe(200);

    const events = await referenceEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      record: { id: source.id, title: 'Source task' },
      reference: { target_record: { id: targetA.id, title: 'Target A' } },
      source: 'human',
    });
    expect((events[0] as { actor: { name: string } | null }).actor?.name).toBeTruthy();
  });

  it('re-saving the SAME content (unchanged mention set) emits ZERO new reference.created events', async () => {
    const before = await referenceEvents();
    // Same mention, same target — the delete+reinsert still runs, but nothing
    // is genuinely new.
    expect((await putDoc(source.id, docMentioning(targetA.id), 1)).statusCode).toBe(200);
    const after = await referenceEvents();
    expect(after).toHaveLength(before.length);
  });

  it('adding a SECOND, genuinely new mention alongside the existing one produces exactly one more event', async () => {
    expect((await putDoc(source.id, docMentioning(targetA.id, targetB.id), 2)).statusCode).toBe(200);
    const events = await referenceEvents();
    // One for A (from the first test) + one for B (new here) = 2 total, ever.
    expect(events).toHaveLength(2);
    const targetIds = events.map((e) => (e as { reference: { target_record: { id: string } } }).reference.target_record.id);
    expect(targetIds.sort()).toEqual([targetA.id, targetB.id].sort());
  });

  it('removing a mention (content no longer references it) does not fabricate a new event for the SURVIVING one', async () => {
    const before = await referenceEvents();
    // Drop B, keep A — A is not "new" (it survives), B is removed (not an
    // addition, so no event either — reference.created is one-directional).
    expect((await putDoc(source.id, docMentioning(targetA.id), 3)).statusCode).toBe(200);
    const after = await referenceEvents();
    expect(after).toHaveLength(before.length);
  });

  it('the database activity feed includes reference entries alongside comments, newest first', async () => {
    await inject('POST', `/workspaces/${ws}/databases/${tasksDb}/records/${source.id}/comments`, {
      body: [{ type: 'text', text: 'a plain comment, no mention' }],
    });
    const res = await inject('GET', `/workspaces/${ws}/databases/${tasksDb}/activity/comments`);
    const types = (res.json().data as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('comment.created');
    expect(types).toContain('reference.created');
    // Newest first: the just-posted comment leads.
    expect(types[0]).toBe('comment.created');
  });
});
