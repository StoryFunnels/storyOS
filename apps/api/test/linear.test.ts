import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { LinearService } from '../src/integrations/linear.service';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

const TEAM_DATA = {
  cycles: { nodes: [
    { id: 'cyc-1', name: null, number: 12, startsAt: '2026-07-01T00:00:00Z', endsAt: '2026-07-14T00:00:00Z' },
  ] },
  projects: { nodes: [
    { id: 'proj-1', name: 'Sharing flow', description: 'Ship the new **sharing** model.\n\n- roles\n- links', state: 'started', targetDate: '2026-08-01', url: 'https://linear.app/acme/project/sharing' },
  ] },
  issues: { nodes: [
    { id: 'iss-1', identifier: 'ENG-1', title: 'Share dialog loses focus', description: '## Repro\n\nOpen the **share** dialog, then tab — focus escapes. See [the thread](https://linear.app/x).', url: 'https://linear.app/acme/issue/ENG-1', estimate: 3, priority: 2, state: { type: 'started', name: 'In Progress' }, labels: { nodes: [{ name: 'bug' }] }, assignee: { name: 'Dana K' }, parent: null, cycle: { id: 'cyc-1' }, project: { id: 'proj-1' } },
    { id: 'iss-2', identifier: 'ENG-2', title: 'Fix focus trap', description: null, url: 'https://linear.app/acme/issue/ENG-2', estimate: null, priority: 0, state: { type: 'triage', name: 'Triage' }, labels: { nodes: [] }, assignee: null, parent: { id: 'iss-1' }, cycle: null, project: null },
    { id: 'iss-3', identifier: 'ENG-3', title: 'Old spike', description: '', url: 'https://linear.app/acme/issue/ENG-3', estimate: 1, priority: 4, state: { type: 'canceled', name: 'Canceled' }, labels: { nodes: [{ name: 'spike' }, { name: 'infra' }] }, assignee: null, parent: null, cycle: null, project: null },
  ] },
};

beforeAll(async () => {
  app = await createTestApp();
  const linear = app.get(LinearService);
  linear.fetcher = async (query) => {
    if (query.includes('teams {')) {
      return { teams: { nodes: [
        { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        { id: 'team-ops', key: 'OPS', name: 'Operations' },
      ] } };
    }
    return { team: TEAM_DATA };
  };
  admin = await signUpUser(app, 'Migrator');
  wsId = (await inject('POST', '/workspaces', { name: 'Linear WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('Linear importer (MN-066)', () => {
  it('requires an API key; saves config with a team filter', async () => {
    const early = await inject('POST', `/workspaces/${wsId}/integrations/linear/dry-run`);
    expect(early.statusCode).toBe(422);
    const save = await inject('POST', `/workspaces/${wsId}/integrations/linear`, {
      api_key: 'lin_api_test', team_keys: ['ENG'],
    });
    expect(save.statusCode, save.body).toBe(201);
    const config = (await inject('GET', `/workspaces/${wsId}/integrations/linear`)).json();
    expect(config.has_key).toBe(true);
    expect(config.team_keys).toEqual(['ENG']);
  });

  it('dry-run reports counts per team and writes nothing', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().teams).toEqual([{ key: 'ENG', name: 'Engineering', issues: 3, sprints: 1, projects: 1 }]);
    const spaces = (await inject('GET', `/workspaces/${wsId}/spaces`)).json();
    expect(spaces.some((s: { name: string }) => s.name.includes('Linear'))).toBe(false);
  });

  it('imports the team into a dev-project-shaped space with mapped states and links', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ issues: 3, sprints: 1, projects: 1, teams: ['ENG'] });

    const dbs = (await inject('GET', `/workspaces/${wsId}/databases`)).json();
    const issuesDb = dbs.find((d: { name: string }) => d.name === 'Issues');
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}`)).json();
    const stateField = detail.fields.find((f: { apiName: string }) => f.apiName === 'state');
    const optionId = (label: string) => stateField.options.find((o: { label: string }) => o.label === label).id;

    const list = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records?limit=50`)).json();
    expect(list.data).toHaveLength(3);
    const eng1 = list.data.find((r: { title: string }) => r.title === 'Share dialog loses focus');
    expect(eng1.values.state).toBe(optionId('In Progress'));
    expect(eng1.values.assignee_name).toBe('Dana K'); // preserved as text — no user matching
    expect(eng1.values.estimate).toBe(3);
    expect(eng1.values.sprint?.title ?? eng1.values.sprint?.[0]?.title).toBeTruthy();
    expect(eng1.values.project?.title ?? eng1.values.project?.[0]?.title).toBe('Sharing flow');

    const eng2 = list.data.find((r: { title: string }) => r.title === 'Fix focus trap');
    expect(eng2.values.state).toBe(optionId('Triage'));
    expect(eng2.values.parent_issue?.title ?? eng2.values.parent_issue?.[0]?.title).toBe('Share dialog loses focus');
    const eng3 = list.data.find((r: { title: string }) => r.title === 'Old spike');
    expect(eng3.values.state).toBe(optionId('Canceled'));
    expect(eng3.values.labels).toBe('spike, infra');
  });

  it('imports Linear descriptions as record documents (MN-070)', async () => {
    const dbs = (await inject('GET', `/workspaces/${wsId}/databases`)).json();
    const issuesDb = dbs.find((d: { name: string }) => d.name === 'Issues');
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records?limit=50`)).json();
    const eng1 = list.data.find((r: { title: string }) => r.title === 'Share dialog loses focus');

    const doc = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records/${eng1.id}/document`)).json();
    expect(doc.version).toBeGreaterThan(0);
    const blocks = doc.content as Array<{ type: string; props?: { level?: number }; content?: Array<{ text?: string }> }>;
    expect(blocks[0]).toMatchObject({ type: 'heading', props: { level: 2 } });
    expect(JSON.stringify(blocks)).toContain('the thread'); // link label preserved

    // ENG-2 (null) and ENG-3 (empty) get no document
    const eng2 = list.data.find((r: { title: string }) => r.title === 'Fix focus trap');
    const doc2 = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records/${eng2.id}/document`)).json();
    expect(doc2.version).toBe(0);
  });

  it('re-import never clobbers a description edited in StoryOS', async () => {
    const dbs = (await inject('GET', `/workspaces/${wsId}/databases`)).json();
    const issuesDb = dbs.find((d: { name: string }) => d.name === 'Issues');
    let list = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records?limit=50`)).json();
    const eng1 = list.data.find((r: { title: string }) => r.title === 'Share dialog loses focus');

    // user edits the description
    const edited = [{ type: 'paragraph', content: [{ type: 'text', text: 'My own notes', styles: {} }] }];
    const cur = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records/${eng1.id}/document`)).json();
    await inject('PUT', `/workspaces/${wsId}/databases/${issuesDb.id}/records/${eng1.id}/document`, {
      content: edited, expected_version: cur.version,
    });

    await inject('POST', `/workspaces/${wsId}/integrations/linear/sync`);

    const after = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records/${eng1.id}/document`)).json();
    expect(JSON.stringify(after.content)).toContain('My own notes'); // import left the edit alone
  });

  it('re-import is idempotent and picks up changes', async () => {
    TEAM_DATA.issues.nodes[0]!.state = { type: 'completed', name: 'Done' };
    const res = await inject('POST', `/workspaces/${wsId}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);

    const dbs = (await inject('GET', `/workspaces/${wsId}/databases`)).json();
    const issuesDb = dbs.find((d: { name: string }) => d.name === 'Issues');
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records?limit=50`)).json();
    expect(list.data).toHaveLength(3); // no duplicates
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}`)).json();
    const stateField = detail.fields.find((f: { apiName: string }) => f.apiName === 'state');
    const done = stateField.options.find((o: { label: string }) => o.label === 'Done').id;
    const eng1 = list.data.find((r: { title: string }) => r.title === 'Share dialog loses focus');
    expect(eng1.values.state).toBe(done);
  });
});
