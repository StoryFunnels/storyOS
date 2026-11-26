import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call as rawCall, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { accessGrants, activityEvents, automationRuns, automations, databases, memberships, notifications } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';

/**
 * Ticket #1361 — an admin can take a rule over, and "needs a new owner" reads the owner's CURRENT access.
 *
 * Fixture shape (the one automation-action-access.test.ts uses): Orders and Targets, BOTH restricted, so only a grant gives anyone
 * access. A MEMBER holding creator on both builds a rule; the rule's owner then loses something; somebody takes it over.
 * "Cleared" is read from the API, "ran" from the produced state (a changed field) and never from the run row alone.
 */
let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let admin: { token: string; email: string };
let adminId: string;
let wsId: string;
let spaceId: string;

const as = (token: string, method: string, url: string, payload?: unknown) => rawCall(app, token, method, url, payload);
const asAdmin = (method: string, url: string, payload?: unknown) => as(admin.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<Db>(DB);
  engine = app.get(AutomationsService);
  admin = await signUpUser(app, 'Take Over Admin');
  wsId = (await asAdmin('POST', '/workspaces', { name: 'Take over WS' })).json().id;
  spaceId = (await asAdmin('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  adminId = (await asAdmin('GET', '/me')).json().id;
});

afterAll(async () => {
  await app?.close();
});

interface Fx {
  orders: string;
  targets: string;
  notesField: string;
  notesApi: string;
  statusApi: string;
  relField: string;
}

async function fixture(): Promise<Fx> {
  const orders = (await asAdmin('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Orders ${randomUUID()}` })).json().id as string;
  const targets = (await asAdmin('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Targets ${randomUUID()}` })).json().id as string;
  const notes = (await asAdmin('POST', `/workspaces/${wsId}/databases/${orders}/fields`, { display_name: 'Notes', type: 'text', config: {} })).json();
  const status = (await asAdmin('POST', `/workspaces/${wsId}/databases/${orders}/fields`, { display_name: 'Status', type: 'text', config: {} })).json();
  await asAdmin('POST', `/workspaces/${wsId}/databases/${targets}/fields`, { display_name: 'Status', type: 'text', config: {} });
  const rel = (await asAdmin('POST', `/workspaces/${wsId}/relations`, { database_a_id: orders, database_b_id: targets, cardinality: 'many_to_many' })).json();
  await setRestricted(app, admin.token, wsId, 'database', orders);
  await setRestricted(app, admin.token, wsId, 'database', targets);
  return { orders, targets, notesField: notes.id, notesApi: notes.apiName, statusApi: status.apiName, relField: rel.field_a.id };
}

/** A member holding `role` on Orders and Targets (creator by default: able to build every rule below). */
const member = (f: Fx, name: string, role = 'creator'): Promise<Person> =>
  joinAs(app, admin.token, wsId, name, 'member', [
    { database_id: f.orders, role },
    { database_id: f.targets, role },
  ]);

async function newRule(person: Person, f: Fx, actions: unknown[]) {
  const res = await as(person.token, 'POST', `/workspaces/${wsId}/databases/${f.orders}/automations`, {
    name: `Rule ${randomUUID()}`,
    trigger: { type: 'record_updated', field_id: f.notesField },
    actions,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

const setStatus = (f: Fx) => [{ type: 'set_values', values: { [f.statusApi]: 'done' } }];
const ruleUrl = (f: Fx, id: string) => `/workspaces/${wsId}/databases/${f.orders}/automations/${id}`;
const takeOver = (token: string, f: Fx, id: string) => as(token, 'POST', `${ruleUrl(f, id)}/take-over`);
const getRule = async (f: Fx, id: string) => (await asAdmin('GET', ruleUrl(f, id))).json();
const rowOf = async (id: string) => (await db.select().from(automations).where(eq(automations.id, id)))[0]!;
const runsOf = (ruleId: string) => db.select().from(automationRuns).where(eq(automationRuns.automationId, ruleId)).orderBy(desc(automationRuns.createdAt));

async function degrade(person: Person, how: 'viewer' | 'revoked' | 'left') {
  if (how === 'viewer') await db.update(accessGrants).set({ role: 'viewer' }).where(and(eq(accessGrants.userId, person.id), eq(accessGrants.workspaceId, wsId)));
  else if (how === 'revoked') await db.delete(accessGrants).where(and(eq(accessGrants.userId, person.id), eq(accessGrants.workspaceId, wsId)));
  else await db.delete(memberships).where(and(eq(memberships.userId, person.id), eq(memberships.workspaceId, wsId)));
}

/** Touch Notes so a record_updated rule fires; wait until that firing's run row has left 'running'. */
async function fire(f: Fx, ruleId: string, recordId: string) {
  const before = (await runsOf(ruleId)).length;
  const res = await asAdmin('PATCH', `/workspaces/${wsId}/databases/${f.orders}/records/${recordId}`, { values: { [f.notesApi]: randomUUID() } });
  expect(res.statusCode, res.body).toBeLessThan(300);
  await engine.settle(recordId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const runs = await runsOf(ruleId);
    if (runs.length > before && runs.every((r) => r.status !== 'running')) return runs[0]!;
    if (Date.now() > deadline) throw new Error('the run did not finish');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const newOrder = async (f: Fx) => (await asAdmin('POST', `/workspaces/${wsId}/databases/${f.orders}/records`, { values: { name: 'Order' } })).json().id as string;
const statusOf = async (f: Fx, id: string) => ((await asAdmin('GET', `/workspaces/${wsId}/databases/${f.orders}/records/${id}`)).json().values as Record<string, unknown>)[f.statusApi];
const ownerNotices = async () =>
  (await db.select().from(notifications).where(eq(notifications.workspaceId, wsId))).filter((n) => n.type.startsWith('automation_')).length;

describe('the flag reads the owner CURRENT access, not the latest run (ticket #1361)', () => {
  it('a demoted owner flags the rule BEFORE it has fired once, on an enabled rule and on a disabled one', async () => {
    const f = await fixture();
    const owner = await member(f, 'Never Fired Nia');
    const live = await newRule(owner, f, setStatus(f));
    const off = await newRule(owner, f, setStatus(f));
    await asAdmin('PATCH', ruleUrl(f, off.id), { enabled: false });
    expect(await getRule(f, live.id)).toMatchObject({ needsNewOwner: false, needsNewOwnerReason: null });

    await degrade(owner, 'viewer');
    expect((await runsOf(live.id)).length, 'the rule has not run since the demotion').toBe(0);
    expect(await getRule(f, live.id)).toMatchObject({ needsNewOwner: true, needsNewOwnerReason: 'lacks_access', ownerMissing: false });
    expect(await getRule(f, off.id)).toMatchObject({ needsNewOwner: true, needsNewOwnerReason: 'lacks_access', enabled: false });
    const list = (await asAdmin('GET', `/workspaces/${wsId}/databases/${f.orders}/automations`)).json().data as Array<{ id: string; needsNewOwnerReason: string | null }>;
    expect(list.find((r) => r.id === live.id)!.needsNewOwnerReason).toBe('lacks_access');
    expect(list.find((r) => r.id === off.id)!.needsNewOwnerReason).toBe('lacks_access');
  });

  it('losing the databases altogether flags it too; restoring access clears it with no run in between', async () => {
    const f = await fixture();
    const owner = await member(f, 'Revoked Rae');
    const rule = await newRule(owner, f, setStatus(f));
    await degrade(owner, 'revoked');
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: true, needsNewOwnerReason: 'lacks_access' });
    await asAdmin('POST', `/workspaces/${wsId}/grants`, { user_id: owner.id, database_id: f.orders, role: 'creator' });
    await asAdmin('POST', `/workspaces/${wsId}/grants`, { user_id: owner.id, database_id: f.targets, role: 'creator' });
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: false, needsNewOwnerReason: null });
  });

  it('a refused run does NOT keep the flag once the owner has their access back (it is not keyed off the latest run)', async () => {
    const f = await fixture();
    const owner = await member(f, 'Restored Ria');
    const rule = await newRule(owner, f, setStatus(f));
    await degrade(owner, 'viewer');
    const refused = await fire(f, rule.id, await newOrder(f));
    expect(refused.status).toBe('error');
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: true, needsNewOwnerReason: 'lacks_access' });
    await db.update(accessGrants).set({ role: 'creator' }).where(and(eq(accessGrants.userId, owner.id), eq(accessGrants.workspaceId, wsId)));
    expect((await runsOf(rule.id))[0]!.status, 'the latest run is still the refusal').toBe('error');
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: false, needsNewOwnerReason: null });
  });

  it('an owner who keeps the access but loses a WRITE TARGET is flagged; one who never lost anything is not', async () => {
    const f = await fixture();
    const owner = await member(f, 'Target Tess');
    const rule = await newRule(owner, f, [{ type: 'create_record', database_id: f.targets, values: {} }]);
    const fine = await newRule(await member(f, 'Fine Finn'), f, [{ type: 'create_record', database_id: f.targets, values: {} }]);
    await db.update(accessGrants).set({ role: 'viewer' }).where(and(eq(accessGrants.userId, owner.id), eq(accessGrants.databaseId, f.targets)));
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: true, needsNewOwnerReason: 'lacks_access' });
    expect(await getRule(f, fine.id)).toMatchObject({ needsNewOwner: false, needsNewOwnerReason: null });
  });

  it('an admin-owned rule is never flagged (what a rule needs is what an admin has)', async () => {
    const f = await fixture();
    const rule = await newRule(admin as unknown as Person, f, setStatus(f));
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: false });
  });
});

describe('take over: the route (ticket #1361)', () => {
  it('an admin takes a demoted owner\'s rule: created_by becomes the caller, the flag clears, and the next run succeeds', async () => {
    const f = await fixture();
    const owner = await member(f, 'Demoted Dan');
    const rule = await newRule(owner, f, setStatus(f));
    await degrade(owner, 'viewer');
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: true });

    const res = await takeOver(admin.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: rule.id, createdBy: adminId, needsNewOwner: false, needsNewOwnerReason: null, ownerMissing: false });
    expect((await rowOf(rule.id)).createdBy).toBe(adminId);
    expect(await getRule(f, rule.id)).toMatchObject({ createdBy: adminId, needsNewOwner: false });

    const rec = await newOrder(f);
    const run = await fire(f, rule.id, rec);
    expect(run.status, run.error ?? '').toBe('ok');
    expect(await statusOf(f, rec)).toBe('done');
  });

  it('a member who left: the rule is taken over (reason left clears)', async () => {
    const f = await fixture();
    const owner = await member(f, 'Departed Dee');
    const rule = await newRule(owner, f, setStatus(f));
    await degrade(owner, 'left');
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwnerReason: 'left' });
    const res = await takeOver(admin.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: false, createdBy: adminId });
  });

  it('a rule with no owner at all is taken over (reason missing clears)', async () => {
    const f = await fixture();
    const rule = await newRule(await member(f, 'Soon Gone'), f, setStatus(f));
    await db.update(automations).set({ createdBy: null }).where(eq(automations.id, rule.id));
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwnerReason: 'missing' });
    expect((await takeOver(admin.token, f, rule.id)).statusCode).toBe(200);
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: false, createdBy: adminId });
  });

  it('a permitted MEMBER (creator on the database and its targets) can take a rule over, and becomes its owner', async () => {
    const f = await fixture();
    const owner = await member(f, 'Old Olga');
    const taker = await member(f, 'New Nate');
    const rule = await newRule(owner, f, [{ type: 'create_record', database_id: f.targets, values: {} }]);
    await degrade(owner, 'revoked');
    const res = await takeOver(taker.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await rowOf(rule.id)).createdBy).toBe(taker.id);
    expect(await getRule(f, rule.id)).toMatchObject({ needsNewOwner: false });
  });

  it('taking over a rule that switched itself off leaves it OFF with its failure streak: the new owner turns it back on', async () => {
    const f = await fixture();
    const owner = await member(f, 'Streak Sam');
    const rule = await newRule(owner, f, setStatus(f));
    await db.update(automations).set({ enabled: false, failureStreak: 10 }).where(eq(automations.id, rule.id));
    await degrade(owner, 'viewer');
    const res = await takeOver(admin.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(200);
    const row = await rowOf(rule.id);
    expect(row.enabled).toBe(false);
    expect(row.failureStreak).toBe(10);
    expect(res.json()).toMatchObject({ enabled: false, needsNewOwner: false });
    // The new owner turns it back on, and it runs.
    expect((await asAdmin('PATCH', ruleUrl(f, rule.id), { enabled: true })).statusCode).toBe(200);
    const rec = await newOrder(f);
    expect((await fire(f, rule.id, rec)).status).toBe('ok');
    expect(await statusOf(f, rec)).toBe('done');
  });

  it('taking over a rule you already own changes nothing and records nothing', async () => {
    const f = await fixture();
    const rule = await newRule(admin as unknown as Person, f, setStatus(f));
    const before = (await db.select().from(activityEvents).where(eq(activityEvents.workspaceId, wsId))).filter((e) => e.type === 'automation.taken_over').length;
    const res = await takeOver(admin.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ createdBy: adminId });
    const after = (await db.select().from(activityEvents).where(eq(activityEvents.workspaceId, wsId))).filter((e) => e.type === 'automation.taken_over').length;
    expect(after).toBe(before);
  });

  it('an unknown rule, and a rule asked for through another database, are 404', async () => {
    const f = await fixture();
    const other = await fixture();
    const rule = await newRule(await member(f, 'Elsewhere Eve'), f, setStatus(f));
    expect((await takeOver(admin.token, f, randomUUID())).statusCode).toBe(404);
    expect((await takeOver(admin.token, other, rule.id)).statusCode).toBe(404);
    expect((await rowOf(rule.id)).createdBy).not.toBe(adminId);
  });
});

describe('take over: who is refused (ticket #1361)', () => {
  it('REFUSED: a member holding only editor on the database (below the rung that builds a rule); the owner is unchanged', async () => {
    const f = await fixture();
    const owner = await member(f, 'Held Hal');
    const editor = await member(f, 'Editor Ed', 'editor');
    const rule = await newRule(owner, f, setStatus(f));
    const res = await takeOver(editor.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(403);
    expect((await rowOf(rule.id)).createdBy).toBe(owner.id);
  });

  it('REFUSED: a member with no grant on the restricted database', async () => {
    const f = await fixture();
    const owner = await member(f, 'Held Hana');
    const outsider = await joinAs(app, admin.token, wsId, 'Outsider Ola', 'member');
    const rule = await newRule(owner, f, setStatus(f));
    const res = await takeOver(outsider.token, f, rule.id);
    expect([403, 404], res.body).toContain(res.statusCode);
    expect((await rowOf(rule.id)).createdBy).toBe(owner.id);
  });

  it('REFUSED: a GUEST, with a viewer grant and with no grant at all', async () => {
    const f = await fixture();
    const owner = await member(f, 'Held Hugo');
    const rule = await newRule(owner, f, setStatus(f));
    const viewerGuest = await joinAs(app, admin.token, wsId, 'Viewer Guest', 'guest', [{ database_id: f.orders, role: 'viewer' }]);
    // a guest must hold some grant to exist: this one holds a grant on the OTHER database only
    const bareGuest = await joinAs(app, admin.token, wsId, 'Bare Guest', 'guest', [{ database_id: f.targets, role: 'viewer' }]);
    for (const g of [viewerGuest, bareGuest]) {
      const res = await takeOver(g.token, f, rule.id);
      expect([403, 404], res.body).toContain(res.statusCode);
    }
    expect((await rowOf(rule.id)).createdBy).toBe(owner.id);
  });

  it('REFUSED: a creator on this database who cannot add records to a database the rule WRITES INTO (the same targets check saving a rule makes)', async () => {
    const f = await fixture();
    const owner = await member(f, 'Writer Wes');
    const rule = await newRule(owner, f, [{ type: 'create_record', database_id: f.targets, values: {} }]);
    const taker = await joinAs(app, admin.token, wsId, 'Half Hanna', 'member', [
      { database_id: f.orders, role: 'creator' },
      { database_id: f.targets, role: 'viewer' },
    ]);
    const res = await takeOver(taker.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(403);
    expect((await rowOf(rule.id)).createdBy).toBe(owner.id);
    // Control: the same person CAN take over a rule that writes nowhere else.
    const plain = await newRule(owner, f, setStatus(f));
    expect((await takeOver(taker.token, f, plain.id)).statusCode).toBe(200);
  });

  it('REFUSED: an update_linked rule whose linked database the taker cannot edit', async () => {
    const f = await fixture();
    const owner = await member(f, 'Linker Lou');
    const rule = await newRule(owner, f, [{ type: 'update_linked', relation_field_id: f.relField, values: {} }]);
    const taker = await joinAs(app, admin.token, wsId, 'Reader Rhea', 'member', [
      { database_id: f.orders, role: 'creator' },
      { database_id: f.targets, role: 'viewer' },
    ]);
    const res = await takeOver(taker.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(403);
    expect((await rowOf(rule.id)).createdBy).toBe(owner.id);
  });

  it('REFUSED: a rule on a system database (it can run for no one), even for an admin; the sentence names the kind, never a title', async () => {
    const f = await fixture();
    const sys = (await db.select().from(databases).where(and(eq(databases.workspaceId, wsId), eq(databases.isSystem, true))).limit(1))[0]!;
    const [rule] = await db
      .insert(automations)
      .values({ databaseId: sys.id, name: 'System rule', trigger: { type: 'record_created' }, actions: [{ type: 'add_comment', body_template: 'x' }], createdBy: null })
      .returning();
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${sys.id}/automations/${rule!.id}/take-over`);
    expect([403, 422], res.body).toContain(res.statusCode);
    expect(res.body).not.toContain('System rule');
    expect((await rowOf(rule!.id)).createdBy).toBeNull();
    void f;
  });

  it('REFUSED: a member cannot take over a rule that sends email with approval switched OFF (only an admin may save that), an admin can', async () => {
    const f = await fixture();
    const owner = await member(f, 'Sender Sue');
    const taker = await member(f, 'Member Max');
    const [rule] = await db
      .insert(automations)
      .values({
        databaseId: f.orders,
        name: 'Ungated',
        trigger: { type: 'record_created' },
        actions: [{ type: 'send_email', to: 'someone@example.com', subject: 's', body_template: 'b', require_approval: false }],
        createdBy: owner.id,
      })
      .returning();
    const res = await takeOver(taker.token, f, rule!.id);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect((await rowOf(rule!.id)).createdBy).toBe(owner.id);
  });

  it('REFUSED: a token below admin scope (the controller is an admin surface, like creating a rule)', async () => {
    const f = await fixture();
    const owner = await member(f, 'Scoped Sol');
    const rule = await newRule(owner, f, setStatus(f));
    const minted = await asAdmin('POST', '/me/tokens', { name: 'write token', workspace_id: wsId, scope: 'write' });
    expect(minted.statusCode, minted.body).toBe(201);
    const res = await takeOver(minted.json().token as string, f, rule.id);
    expect(res.statusCode, res.body).toBe(403);
    expect((await rowOf(rule.id)).createdBy).toBe(owner.id);
  });
});

describe('take over: the record it leaves (ticket #1361)', () => {
  it('writes ONE audit event naming the rule, the caller and both owners, and sends no notification', async () => {
    const f = await fixture();
    const owner = await member(f, 'Audited Ava');
    const rule = await newRule(owner, f, setStatus(f));
    await degrade(owner, 'viewer');
    const noticesBefore = await ownerNotices();
    const res = await takeOver(admin.token, f, rule.id);
    expect(res.statusCode, res.body).toBe(200);
    const events = (await db.select().from(activityEvents).where(eq(activityEvents.workspaceId, wsId))).filter(
      (e) => e.type === 'automation.taken_over' && (e.payload as { object?: { id?: string } }).object?.id === rule.id,
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.actorId).toBe(adminId);
    expect(ev.recordId).toBeNull();
    expect(ev.payload).toMatchObject({ object: { kind: 'automation', id: rule.id }, from: owner.id, to: adminId, database_id: f.orders });
    expect(await ownerNotices(), 'a take-over notifies nobody').toBe(noticesBefore);

    // ...and the workspace audit log returns it, by the rule's id (the rule's history).
    const log = await asAdmin('GET', `/workspaces/${wsId}/audit-log?entity=${rule.id}`);
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().data as Array<{ type: string; object: { id: string } | null; actor_id: string }>;
    expect(rows.find((r) => r.type === 'automation.taken_over')).toMatchObject({ object: { id: rule.id }, actor_id: adminId });
  });

  it('a REFUSED take-over writes no event and moves nothing', async () => {
    const f = await fixture();
    const owner = await member(f, 'Untouched Una');
    const editor = await member(f, 'Weak Wil', 'editor');
    const rule = await newRule(owner, f, setStatus(f));
    const before = (await db.select().from(activityEvents).where(eq(activityEvents.workspaceId, wsId))).length;
    expect((await takeOver(editor.token, f, rule.id)).statusCode).toBe(403);
    expect((await db.select().from(activityEvents).where(eq(activityEvents.workspaceId, wsId))).length).toBe(before);
    expect((await rowOf(rule.id)).createdBy).toBe(owner.id);
  });
});
