import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { activityEvents } from '../src/db/schema';

/**
 * #979 — My Work says WHO assigned each record to me and WHEN. Derived from the activity trail (a `record.updated` event whose diff put
 * the caller into a person field), the LAST such change; null when no change ever did (created with me set, imported, or no history).
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string; id: string };
let bea: { token: string; id: string };
let cy: { token: string; id: string };
let me: { token: string; id: string };
let ws: string, tasks: string, ownerField: string, reviewersField: string;
const names: Record<string, string> = {};
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const mk = async (name: string, values: Record<string, unknown> = {}) => (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name, ...values } })).json().id as string;
const set = (token: string, rec: string, values: Record<string, unknown>) => as(token, 'PATCH', `/workspaces/${ws}/databases/${tasks}/records/${rec}`, { values });
const mine = async (token = me.token, tab = 'assigned') => {
  const res = await as(token, 'GET', `/workspaces/${ws}/my-work?tab=${tab}`);
  expect(res.statusCode, res.body).toBe(200);
  const rows = (res.json().groups as Array<{ database: { id: string }; records: Array<Record<string, unknown> & { id: string; title: string }> }>).find((g) => g.database.id === tasks)?.records ?? [];
  return (title: string) => rows.find((r) => r.title === title);
};

beforeAll(async () => {
  app = await createTestApp();
  const o = await signUpUser(app, 'AB Owner');
  owner = { token: o.token, id: (await as(o.token, 'GET', '/me')).json().id };
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'AB WS' })).json().id;
  const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  ownerField = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Owner', type: 'user' })).json().apiName;
  reviewersField = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Reviewers', type: 'user', config: { multi: true } })).json().apiName;
  bea = await joinAs(app, owner.token, ws, 'AB Bea', 'member');
  cy = await joinAs(app, owner.token, ws, 'AB Cy', 'member');
  me = await joinAs(app, owner.token, ws, 'AB Me', 'member');
  for (const [k, p] of Object.entries({ owner, bea, cy })) names[k] = (await as((p as { token: string }).token, 'GET', '/me')).json().name;
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#979 My Work: who assigned this to me', () => {
  it('a teammate sets me: assigned_by is that person, assigned_at is when, kind user', async () => {
    const rec = await mk('set by bea');
    const before = Date.now();
    expect((await set(bea.token, rec, { [ownerField]: me.id })).statusCode).toBe(200);
    const row = (await mine())('set by bea')!;
    expect(row.assigned_by).toEqual({ id: bea.id, name: names.bea, kind: 'user' });
    expect(Date.parse(row.assigned_at as string)).toBeGreaterThanOrEqual(before - 2000);
    expect(Date.parse(row.assigned_at as string)).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('reassigning A → B → me reports the LAST person who set me; me → removed → me again reports the second setter', async () => {
    const rec = await mk('chain');
    await set(owner.token, rec, { [ownerField]: bea.id }); // owner sets Bea
    await set(cy.token, rec, { [ownerField]: me.id }); // Cy sets me
    expect((await mine())('chain')!.assigned_by).toMatchObject({ id: cy.id });
    await set(bea.token, rec, { [ownerField]: null });
    await set(owner.token, rec, { [ownerField]: me.id }); // the owner puts me back
    expect((await mine())('chain')!.assigned_by, 'the LAST change that put me there').toMatchObject({ id: owner.id });
  });

  it('a person field holding several people: whoever ADDED me, not whoever last touched the field', async () => {
    const rec = await mk('multi');
    await set(owner.token, rec, { [reviewersField]: [cy.id] });
    await set(bea.token, rec, { [reviewersField]: [cy.id, me.id] }); // Bea adds me
    await set(owner.token, rec, { [reviewersField]: [cy.id, me.id, bea.id] }); // owner adds someone ELSE
    expect((await mine())('multi')!.assigned_by, 'the owner changed the field last but did not put me there').toMatchObject({ id: bea.id });
  });

  it('created with me already set (no change ever put me there): both fields are null, never a guess', async () => {
    await mk('born mine', { [ownerField]: me.id });
    const row = (await mine())('born mine')!;
    expect(row.assigned_by).toBeNull();
    expect(row.assigned_at).toBeNull();
  });

  it('an AGENT that set me is reported as an agent, by the agent\'s name', async () => {
    const rec = await mk('by agent');
    await set(owner.token, rec, { [ownerField]: bea.id });
    const field = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${tasks}`)).json().fields.find((f: { apiName: string }) => f.apiName === ownerField);
    await raw.insert(activityEvents).values({
      workspaceId: ws, recordId: rec, actorId: owner.id, type: 'record.updated', payload: { diff: { [field.id]: { from: bea.id, to: me.id } } },
      source: 'agent', agentId: '11111111-1111-4111-8111-111111111111', agentName: 'Triage bot',
    });
    await raw.execute(`UPDATE records SET values = jsonb_set(values, '{${field.id}}', '"${me.id}"') WHERE id = '${rec}'` as never);
    expect((await mine())('by agent')!.assigned_by).toEqual({ id: '11111111-1111-4111-8111-111111111111', name: 'Triage bot', kind: 'agent' });
  });

  it('an actor who no longer exists reads "(deactivated)", the same word the record\'s own activity feed uses', async () => {
    const rec = await mk('ghost setter');
    const field = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${tasks}`)).json().fields.find((f: { apiName: string }) => f.apiName === ownerField);
    await raw.insert(activityEvents).values({ workspaceId: ws, recordId: rec, actorId: 'user-that-was-deleted', type: 'record.updated', payload: { diff: { [field.id]: { from: null, to: me.id } } }, source: 'human' });
    await raw.execute(`UPDATE records SET values = jsonb_set(values, '{${field.id}}', '"${me.id}"') WHERE id = '${rec}'` as never);
    expect((await mine())('ghost setter')!.assigned_by).toEqual({ id: 'user-that-was-deleted', name: '(deactivated)', kind: 'user' });
  });

  it('the created tab carries the keys, null: nothing was assigned', async () => {
    await as(me.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: 'i made this' } });
    const row = (await mine(me.token, 'created'))('i made this')!;
    expect(row).toHaveProperty('assigned_by', null);
    expect(row).toHaveProperty('assigned_at', null);
  });
});

describe('#979 assigned_by shows only what the caller\'s own view of the record already shows', () => {
  it('a guest granted ONE record: the name is the one the record\'s activity feed shows that same guest; records they cannot read never appear', async () => {
    const readable = await mk('guest readable');
    const hidden = await mk('guest hidden');
    const guest = await joinAs(app, owner.token, ws, 'AB Guest', 'guest', [{ database_id: tasks, role: 'viewer' }]);
    await set(bea.token, readable, { [ownerField]: guest.id });
    await set(bea.token, hidden, { [ownerField]: bea.id });
    const row = (await mine(guest.token))('guest readable')!;
    expect(row.assigned_by).toEqual({ id: bea.id, name: names.bea, kind: 'user' });
    expect((await mine(guest.token))('guest hidden'), 'not assigned to the guest: not in their My Work').toBeUndefined();
    const feed = (await as(guest.token, 'GET', `/workspaces/${ws}/databases/${tasks}/records/${readable}/activity`)).json();
    const actors = (feed.data as Array<{ actor: { id: string; name: string } | null }>).map((e) => e.actor).filter(Boolean);
    expect(actors, 'the same name is visible to this guest in the record\'s own activity').toContainEqual({ id: bea.id, name: names.bea });
  });

  it('a stranger with no access to the database sees nothing of it, so no assigned_by either', async () => {
    const other = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Elsewhere' })).json().id;
    const stranger = await joinAs(app, owner.token, ws, 'AB Stranger', 'guest', [{ database_id: other, role: 'viewer' }]);
    const res = await as(stranger.token, 'GET', `/workspaces/${ws}/my-work?tab=assigned`);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(names.bea);
    expect(JSON.stringify(res.json())).not.toContain('by bea');
  });
});
