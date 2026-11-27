import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { GithubService } from '../src/integrations/github.service';

/**
 * Ticket #1370 — GitHub PR linking reads the same per-team ownership state as the Linear sync (one switch, not two to keep in step).
 * A PR still LINKS to a record of a mirrored team whatever the state, but it moves that record's status only once StoryOS owns the
 * team: while Linear owns it, the next sync would put the status back, so a PR would set the same status from two directions
 * (ticket #905's rule). A database that is not a Linear mirror is untouched by any of this.
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
let ws: string;
let mirrorDb: string;
let plainDb: string;
let mirrorRec: { id: string; number: number };
let plainRec: { id: string; number: number };
let state: { api: string; opts: Record<string, string> };
let plainState: { api: string; opts: Record<string, string> };
const SECRET = 'pinewood-cutover-secret-key-0001';
const REPO = 'pinewood/site';
const NOTES_REPO = 'pinewood/notes';

const adm = (m: string, u: string, p?: unknown) => call(app, admin.token, m, u, p);
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
let prNo = 500;
async function open(branch: string, repo = REPO) {
  const number = ++prNo;
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: repo },
    pull_request: { number, title: `Change ${number}`, state: 'open', merged: false, merged_at: null, draft: false, html_url: `https://github.com/${repo}/pull/${number}`, body: null, user: { login: 'dana' }, head: { ref: branch, sha: 'deadbeef' } },
  });
  const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) }, payload: body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { linked_record_id: string | null; state_applied: string | null; state_skipped?: string };
}
const stateOf = async (database: string, record: string, api: string) => ((await adm('GET', `/workspaces/${ws}/databases/${database}/records/${record}`)).json().values[api] ?? null) as string | null;
const setOwnership = (entry: unknown) =>
  rawDb.execute(sql`UPDATE workspaces SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{linear}', coalesce(settings->'linear', '{}'::jsonb) || ${JSON.stringify(entry)}::jsonb) WHERE id = ${ws}`);

async function mkDb(space: string, name: string, prefix: string, withLinearId: boolean) {
  const id = (await adm('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  expect((await adm('PATCH', `/workspaces/${ws}/databases/${id}`, { identifier_prefix: prefix })).statusCode).toBe(200);
  if (withLinearId) expect((await adm('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: 'Linear ID', type: 'text', config: {} })).statusCode).toBe(201);
  const f = (await adm('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: 'State', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'In Progress' }] })).json();
  const rec = (await adm('POST', `/workspaces/${ws}/databases/${id}/records`, { values: { name: `${name} item` } })).json();
  return { id, rec: { id: rec.id as string, number: rec.number as number }, state: { api: f.apiName as string, opts: Object.fromEntries(f.options.map((o: { label: string; id: string }) => [o.label, o.id])) } };
}

beforeAll(async () => {
  app = await createTestApp();
  app.get(GithubService).fetcher = async () => ({ state: 'pending' });
  admin = await signUpUser(app, 'Cutover Github Admin');
  ws = (await adm('POST', '/workspaces', { name: 'Cutover Github WS' })).json().id;
  const space = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const mirror = await mkDb(space, 'Issues', 'ENG', true);
  mirrorDb = mirror.id; mirrorRec = mirror.rec; state = mirror.state;
  const plain = await mkDb(space, 'Notes', 'NOTE', false);
  plainDb = plain.id; plainRec = plain.rec; plainState = plain.state;
  // The Issues database is the mirror of Linear team ENG: the sync stored its space id against the team key.
  await setOwnership({ team_keys: ['ENG'], team_spaces: { ENG: { space_id: space } } });
  const saved = await call(app, admin.token, 'POST', `/workspaces/${ws}/integrations/github`, {
    webhook_secret: SECRET,
    repos: [REPO, NOTES_REPO],
    link_database_id: mirrorDb,
    state_automation: { opened: 'In Progress' },
  });
  expect(saved.statusCode, saved.body).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('GitHub reads the one ownership switch (ticket #1370)', () => {
  it('while Linear owns the team a PR links to the record but does NOT move its status, and says why', async () => {
    const out = await open(`feat/eng-${mirrorRec.number}`);
    expect(out.linked_record_id).toBe(mirrorRec.id);
    expect(out.state_applied).toBeNull();
    expect(out.state_skipped).toBe('team_owned_by_linear');
    expect(await stateOf(mirrorDb, mirrorRec.id, state.api)).toBeNull();
  });

  it('once StoryOS owns the team the same PR moves the status', async () => {
    await setOwnership({ team_ownership: { ENG: { owner: 'storyos', changed_at: '2026-12-01T00:00:00.000Z', changed_by: 'u' } } });
    const out = await open(`feat/eng-${mirrorRec.number}`);
    expect(out.state_applied).toBe('In Progress');
    expect(await stateOf(mirrorDb, mirrorRec.id, state.api)).toBe(state.opts['In Progress']);
  });

  it('handed back to Linear, it stops again', async () => {
    await rawDb.execute(sql`UPDATE records SET values = values - ${state.api} WHERE id = ${mirrorRec.id}`);
    await setOwnership({ team_ownership: { ENG: { owner: 'linear', changed_at: '2026-12-02T00:00:00.000Z', changed_by: 'u' } } });
    const out = await open(`feat/eng-${mirrorRec.number}`);
    expect(out.state_applied).toBeNull();
    expect(out.state_skipped).toBe('team_owned_by_linear');
  });

  it('a database that is not a Linear mirror is not touched by the switch: a PR from the repo that links to it still moves its status', async () => {
    expect((await call(app, admin.token, 'POST', `/workspaces/${ws}/integrations/github`, { link_databases: { [NOTES_REPO]: plainDb } })).statusCode).toBe(201);
    const out = await open(`feat/note-${plainRec.number}`, NOTES_REPO);
    expect(out.linked_record_id, 'it really links').toBe(plainRec.id);
    expect(out.state_skipped).toBeUndefined();
    expect(out.state_applied).toBe('In Progress');
    expect(await stateOf(plainDb, plainRec.id, plainState.api)).toBe(plainState.opts['In Progress']);
  });
});
