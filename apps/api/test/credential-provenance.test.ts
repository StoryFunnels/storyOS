import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';

/**
 * #882 — for a past action, which CREDENTIAL did it, and what could that credential reach, answerable through the API and after
 * revocation or erasure (the second half of #543's AC3). AC1 answer, recorded here: the closest existing surface is the agent
 * attribution triplet (#541: source / agent_id / agent_name) that activity_events, record_versions and record_field_changes already
 * carry; this adds ONE sibling column, token_id, to those same three tables rather than a new provenance store.
 *
 * Admin-only on every route, and asserted for a member, a guest and a bound token too (#881). Nothing here returns the token's
 * user_id, so an erased person cannot be resolved back through the link.
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, tasks: string, other: string;
let bob: Person, gina: Person;
let t1: { id: string; token: string }, t2: { id: string; token: string }, tBob: { id: string; token: string };
let r1: string, r2: string, rBound: string;
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const own = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const mint = async (token: string, body: Record<string, unknown>) => {
  const res = await as(token, 'POST', '/me/tokens', { workspace_id: ws, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id as string, token: res.json().token as string };
};
const credUrl = (id: string) => `/workspaces/${ws}/credentials/${id}`;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'CP Owner');
  ws = (await own('POST', '/workspaces', { name: 'Provenance WS' })).json().id;
  const space = (await own('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await own('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  other = (await own('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Other' })).json().id;
  bob = await joinAs(app, owner.token, ws, 'CP Bob', 'member');
  gina = await joinAs(app, owner.token, ws, 'CP Gina', 'guest', [{ database_id: tasks, role: 'viewer' }]);
  t1 = await mint(owner.token, { name: 'ci robot', scope: 'admin' });
  t2 = await mint(owner.token, { name: 'bound robot', scope: 'admin', resource_scope: { database_ids: [tasks] } });
  tBob = await mint(bob.token, { name: "Bob's laptop", scope: 'admin' });
  r1 = (await as(t1.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: 'made by the robot' } })).json().id;
  r2 = (await own('POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: 'made in a session' } })).json().id;
  const rb = await as(t2.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: 'made by the bound robot' } });
  expect(rb.statusCode, rb.body).toBe(201);
  rBound = rb.json().id;
  await as(tBob.token, 'POST', `/workspaces/${ws}/databases/${other}/records`, { values: { name: 'made by bob token' } });
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#882 action → credential', () => {
  it('the actions of a credential are exactly the actions it took (not the session write, not another token)', async () => {
    const res = await own('GET', `${credUrl(t1.id)}/actions`);
    expect(res.statusCode, res.body).toBe(200);
    const actions = res.json().data as Array<{ record_id: string; type: string }>;
    expect(actions.map((a) => a.record_id)).toEqual([r1]);
    expect(actions[0]!.type).toBe('record.created');
    const bound = (await own('GET', `${credUrl(t2.id)}/actions`)).json().data as Array<{ record_id: string }>;
    expect(bound.map((a) => a.record_id)).toEqual([rBound]);
  });

  it('given one past action, the API names the credential that performed it', async () => {
    const [ev] = (await own('GET', `${credUrl(t1.id)}/actions`)).json().data as Array<{ id: string }>;
    const res = await own('GET', `/workspaces/${ws}/activity-events/${ev!.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().credential_id).toBe(t1.id);
    // a session write names no credential: absence is reported as absence, not as a person
    const sessionEv = await rawDb.query.activityEvents.findFirst({ where: (e, { eq }) => eq(e.recordId, r2) });
    const none = await own('GET', `/workspaces/${ws}/activity-events/${sessionEv!.id}`);
    expect(none.json().credential_id).toBeNull();
  });

  it('the linkage is also on record versions and field changes (the same triplet #541 stamps)', async () => {
    await as(t1.token, 'PATCH', `/workspaces/${ws}/databases/${tasks}/records/${r1}`, { values: { name: 'renamed by robot' } });
    const v = await rawDb.query.recordVersions.findFirst({ where: (x, { eq }) => eq(x.recordId, r1) });
    expect(v?.tokenId).toBe(t1.id);
  });
});

describe('#882 a credential and its scope, including after revocation', () => {
  it('returns the scope of a live token, with no user identity in the body', async () => {
    const res = await own('GET', credUrl(t2.id));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().resource_scope).toEqual({ space_ids: [], database_ids: [tasks] });
    expect(res.json().revoked_at).toBeNull();
    for (const needle of ['user_id', 'userId', 'token_hash', 'tokenHash']) expect(res.body).not.toContain(needle);
  });

  it('still returns the scope after the token is revoked, and its actions are still attributable', async () => {
    expect((await own('DELETE', `/me/tokens/${t2.id}`)).statusCode).toBeLessThan(300);
    const res = await own('GET', credUrl(t2.id));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().resource_scope.database_ids).toEqual([tasks]);
    expect(res.json().revoked_at).not.toBeNull();
    expect(((await own('GET', `${credUrl(t2.id)}/actions`)).json().data as unknown[]).length).toBe(1);
  });

  it('a credential id from another workspace (or a made-up one) is a 404', async () => {
    const o2 = await signUpUser(app, 'CP Other Owner');
    const w2 = (await call(app, o2.token, 'POST', '/workspaces', { name: 'Elsewhere' })).json().id;
    expect((await call(app, o2.token, 'GET', `/workspaces/${w2}/credentials/${t1.id}`)).statusCode).toBe(404);
    expect((await own('GET', credUrl('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(404);
  });
});

describe('#882 MUST NOT undo the erasure anonymisation', () => {
  it("an erased person's token still yields its scope and its actions, and resolves to nobody", async () => {
    const members = (await own('GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id: string }>;
    const mid = members.find((m) => m.user_id === bob.id)!.id;
    expect((await own('POST', `/workspaces/${ws}/members/${mid}/gdpr/anonymize`)).statusCode).toBe(200);
    const res = await own('GET', credUrl(tBob.id));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().name).toBe('Erased token');
    expect(res.json().revoked_at).not.toBeNull();
    for (const needle of [bob.id, bob.email, 'erased:', "Bob's"]) expect(res.body, `must not contain ${needle}`).not.toContain(needle);
    const actions = await own('GET', `${credUrl(tBob.id)}/actions`);
    expect(actions.json().data).toHaveLength(1);
    for (const needle of [bob.id, bob.email]) expect(actions.body, `actions must not contain ${needle}`).not.toContain(needle);
  });
});

describe('#882 admin-only: a member, a guest and a bound token learn nothing', () => {
  it.each([
    ['a member', () => joinAs(app, owner.token, ws, 'CP Member2', 'member').then((p) => p.token)],
    ['a guest', async () => gina.token],
  ])('%s is refused on every route', async (_n, tok) => {
    const token = await tok();
    for (const url of [credUrl(t1.id), `${credUrl(t1.id)}/actions`, `/workspaces/${ws}/activity-events/00000000-0000-4000-8000-000000000000`]) {
      const res = await as(token, 'GET', url);
      expect([403, 404], `${url}: ${res.body}`).toContain(res.statusCode);
      expect(res.body).not.toContain(t1.id);
    }
  });

  it('a token bound to databases (even an admin one) is refused', async () => {
    const bound = await mint(owner.token, { name: 'another bound', scope: 'admin', resource_scope: { database_ids: [tasks] } });
    for (const url of [credUrl(t1.id), `${credUrl(t1.id)}/actions`]) {
      const res = await as(bound.token, 'GET', url);
      expect([403, 404], `${url}: ${res.body}`).toContain(res.statusCode);
      expect(res.body).not.toContain(t1.id);
    }
  });
});
