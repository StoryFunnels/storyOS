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
import { accessGrants, activityEvents, automationJobs, automationRuns, automations, memberships, notifications, records } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { ActionAccessGuardService } from '../src/automations/action-access-guard.service';

/**
 * Ticket #1353 — every automation action re-checks its actor's access when it RUNS, not only when the rule is saved.
 *
 * Shape of each case: a rule is built by a MEMBER who holds a creator grant; the rule runs once while that is true (the positive
 * control: the action happened) and once more after the member lost something (the action did not happen, the run recorded a
 * refusal that names the person but no title, and the rule's failure streak moved). "Happened" is read from the produced state
 * (a changed field, a new record, a queued job), never from the run row alone.
 */
let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let jobs: JobRunnerService;
let guard: ActionAccessGuardService;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;
let adminId: string;

const as = (token: string, method: string, url: string, payload?: unknown) => rawCall(app, token, method, url, payload);
const asAdmin = (method: string, url: string, payload?: unknown) => as(admin.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<Db>(DB);
  engine = app.get(AutomationsService);
  jobs = app.get(JobRunnerService);
  guard = app.get(ActionAccessGuardService);
  admin = await signUpUser(app, 'Run Time Admin');
  wsId = (await asAdmin('POST', '/workspaces', { name: 'Run time access WS' })).json().id;
  spaceId = (await asAdmin('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  adminId = (await asAdmin('GET', '/me')).json().id;
});

afterAll(async () => {
  await app?.close();
});

const ORDER_TITLE = 'ZEBRA-ORDER-7731';
const LINKED_TITLE = 'ZEBRA-LINKED-7731';

interface Fx {
  orders: string;
  targets: string;
  notesField: string;
  notesApi: string;
  statusApi: string;
  relField: string;
}

/** Orders (Notes, Status) and Targets, related many-to-many; BOTH restricted, so only a grant gives anyone access. */
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

/** A member holding creator on both databases: able to build every rule below. */
const maker = (f: Fx, name: string): Promise<Person> =>
  joinAs(app, admin.token, wsId, name, 'member', [
    { database_id: f.orders, role: 'creator' },
    { database_id: f.targets, role: 'creator' },
  ]);

async function newRule(person: Person, f: Fx, actions: unknown[], trigger: unknown = { type: 'record_updated', field_id: f.notesField }) {
  const res = await as(person.token, 'POST', `/workspaces/${wsId}/databases/${f.orders}/automations`, { name: `Rule ${randomUUID()}`, trigger, actions });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

/** An order (and a linked Targets record) the rule can act on. */
async function order(f: Fx, withLink = true): Promise<{ id: string; linked: string | null }> {
  const id = (await asAdmin('POST', `/workspaces/${wsId}/databases/${f.orders}/records`, { values: { name: ORDER_TITLE } })).json().id as string;
  let linked: string | null = null;
  if (withLink) {
    linked = (await asAdmin('POST', `/workspaces/${wsId}/databases/${f.targets}/records`, { values: { name: LINKED_TITLE } })).json().id as string;
    const l = await asAdmin('POST', `/workspaces/${wsId}/databases/${f.orders}/records/${id}/links/${f.relField}`, { record_ids: [linked] });
    expect(l.statusCode, l.body).toBe(201);
  }
  return { id, linked };
}

const runsOf = (ruleId: string) => db.select().from(automationRuns).where(eq(automationRuns.automationId, ruleId)).orderBy(desc(automationRuns.createdAt));

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

type How = 'viewer' | 'revoked' | 'left';
/** What the member loses: edit (a viewer grant now), the databases altogether (no grant), or the workspace (membership gone). */
async function degrade(person: Person, how: How) {
  if (how === 'viewer') await db.update(accessGrants).set({ role: 'viewer' }).where(and(eq(accessGrants.userId, person.id), eq(accessGrants.workspaceId, wsId)));
  else if (how === 'revoked') await db.delete(accessGrants).where(and(eq(accessGrants.userId, person.id), eq(accessGrants.workspaceId, wsId)));
  else await db.delete(memberships).where(and(eq(memberships.userId, person.id), eq(memberships.workspaceId, wsId)));
}

interface Ctx {
  f: Fx;
  rec: { id: string; linked: string | null };
  ruleId: string;
  person: Person;
}
const statusOf = async (f: Fx, dbId: string, id: string) =>
  ((await asAdmin('GET', `/workspaces/${wsId}/databases/${dbId}/records/${id}`)).json().values as Record<string, unknown>)[f.statusApi];
const countIn = async (dbId: string, name?: string) =>
  (await db.select({ id: records.id, title: records.title }).from(records).where(eq(records.databaseId, dbId))).filter((r) => !name || r.title === name).length;

interface ActionCase {
  type: string;
  action: (f: Fx) => unknown;
  /** The least a member can lose that must stop this action. */
  refusedWhen: How;
  /** A number that goes UP when the action happened. */
  read: (c: Ctx) => Promise<number>;
}
const cases: ActionCase[] = [
  { type: 'set_values', action: (f) => ({ type: 'set_values', values: { [f.statusApi]: 'done' } }), refusedWhen: 'viewer', read: async (c) => ((await statusOf(c.f, c.f.orders, c.rec.id)) === 'done' ? 1 : 0) },
  {
    type: 'add_comment',
    action: () => ({ type: 'add_comment', body_template: 'rule ran' }),
    // Comments need only the commenter rung, which a viewer grant does not give.
    refusedWhen: 'viewer',
    read: async (c) => ((await asAdmin('GET', `/workspaces/${wsId}/databases/${c.f.orders}/records/${c.rec.id}/comments`)).json().data as unknown[]).length,
  },
  {
    type: 'notify_user',
    // Not '@me': a person is never notified of their own action, so the admin is the one pinged.
    action: () => ({ type: 'notify_user', user: `@member:${adminId}`, message: 'ping' }),
    // Reading is all this needs, so a viewer is still allowed; losing the database is not.
    refusedWhen: 'revoked',
    read: async (c) => (await db.select().from(notifications).where(and(eq(notifications.userId, adminId), eq(notifications.workspaceId, wsId)))).length,
  },
  { type: 'create_record', action: (f) => ({ type: 'create_record', database_id: f.targets, values: { name: 'Made by rule' } }), refusedWhen: 'viewer', read: (c) => countIn(c.f.targets, 'Made by rule') },
  { type: 'create_records', action: (f) => ({ type: 'create_records', database_id: f.targets, count: 2, values: { name: 'Batch by rule' } }), refusedWhen: 'viewer', read: (c) => countIn(c.f.targets, 'Batch by rule') },
  {
    type: 'update_linked',
    action: (f) => ({ type: 'update_linked', relation_field_id: f.relField, values: { [f.statusApi]: 'done' } }),
    refusedWhen: 'viewer',
    read: async (c) => ((await statusOf(c.f, c.f.targets, c.rec.linked!)) === 'done' ? 1 : 0),
  },
  {
    type: 'send_slack_message',
    action: () => ({ type: 'send_slack_message', channel: '#general', text: 'hello', require_approval: false }),
    refusedWhen: 'viewer',
    // Slack is not configured in a test, so the executor catches that and the run still ends 'ok': an ok run IS "the action was reached".
    read: async (c) => (await runsOf(c.ruleId)).filter((r) => r.status === 'ok').length,
  },
  {
    type: 'send_webhook',
    action: () => ({ type: 'send_webhook', url: 'https://example.invalid/hook', require_approval: false }),
    refusedWhen: 'viewer',
    read: async (c) => (await runsOf(c.ruleId)).filter((r) => r.status === 'ok').length,
  },
  {
    type: 'http_request',
    action: () => ({ type: 'http_request', method: 'POST', url: 'https://example.invalid/hook' }),
    refusedWhen: 'viewer',
    read: async (c) => (await db.select().from(automationJobs).where(eq(automationJobs.ruleId, c.ruleId))).length,
  },
];

describe('every action refuses a rule whose owner lost what it needs, and still runs for one who has it (ticket #1353)', () => {
  for (const c of cases) {
    for (const how of [c.refusedWhen, 'left'] as How[]) {
      const code = how === 'left' ? 'automation_owner_missing' : 'automation_owner_no_access';
      it(`${c.type}: owner ${how === 'left' ? 'left the workspace' : how === 'revoked' ? 'lost the databases' : 'was demoted to viewer'} -> refused (${code}), nothing happens, no title leaks`, async () => {
        const f = await fixture();
        const name = `Maker ${c.type} ${how}`;
        const person = await maker(f, name);
        const rule = await newRule(person, f, [c.action(f)]);

        // Positive control: the same rule, owner intact, does the thing.
        const first = await order(f);
        const ctx1: Ctx = { f, rec: first, ruleId: rule.id, person };
        const before1 = await c.read(ctx1);
        const ok = await fire(f, rule.id, first.id);
        expect(ok.status, ok.error ?? '').toBe('ok');
        expect(await c.read(ctx1)).toBeGreaterThan(before1);

        await degrade(person, how);

        const second = await order(f);
        const ctx2: Ctx = { f, rec: second, ruleId: rule.id, person };
        const before2 = await c.read(ctx2);
        const refused = await fire(f, rule.id, second.id);
        expect(refused.status).toBe('error');
        expect(refused.error).toMatch(new RegExp(`^${code}: `));
        expect(refused.error).toContain(c.type);
        // The audience of a run row is wider than the record's: the person and the kind of record, never a title.
        expect(refused.error).not.toContain(ORDER_TITLE);
        expect(refused.error).not.toContain(LINKED_TITLE);
        if (how !== 'left') expect(refused.error).toContain(name);
        // Nothing happened, and the failure counts toward the rule's streak (which is what stops a rule that can never succeed).
        expect(await c.read(ctx2)).toBeLessThanOrEqual(before2);
        const [row] = await db.select().from(automations).where(eq(automations.id, rule.id));
        expect(row!.failureStreak).toBeGreaterThanOrEqual(1);
      });
    }
  }
});

describe('the guard itself, for the action kinds that need no outside service (ticket #1353)', () => {
  it('send_email, post_social and run_agent need the rule-building rung a rule owner had when saving; a presser needs only editor', async () => {
    const f = await fixture();
    const person = await maker(f, 'Guard direct');
    const rec = { id: randomUUID() } as never;
    const actions = [
      { type: 'send_email', connection_id: randomUUID(), to: 'a@b.co', subject: 's', body_template: 'b' },
      { type: 'post_social', connection_id: randomUUID(), target: 'x', text_template: 't' },
      { type: 'run_agent', agent: 'x' },
    ] as never[];
    const ruleCtx = { workspaceId: wsId, databaseId: f.orders, record: rec, actorId: person.id, ruleId: randomUUID() };
    for (const a of actions) await expect(guard.check(a, ruleCtx)).resolves.toBeUndefined();
    await degrade(person, 'viewer');
    for (const a of actions) await expect(guard.check(a, ruleCtx)).rejects.toMatchObject({ response: { code: 'automation_owner_no_access' } });
    await degrade(person, 'left');
    for (const a of actions) await expect(guard.check(a, ruleCtx)).rejects.toMatchObject({ response: { code: 'automation_owner_missing' } });
  });

  it('a presser holding editor (not creator) is NOT refused for an outward action: pressing never needed the rule-builder rung', async () => {
    const f = await fixture();
    const presser = await joinAs(app, admin.token, wsId, 'Editor only', 'member', [{ database_id: f.orders, role: 'editor' }]);
    const a = { type: 'send_webhook', url: 'https://example.invalid/x' } as never;
    await expect(guard.check(a, { workspaceId: wsId, databaseId: f.orders, record: null, actorId: presser.id })).resolves.toBeUndefined();
    await expect(guard.check(a, { workspaceId: wsId, databaseId: f.orders, record: null, actorId: presser.id, ruleId: randomUUID() })).rejects.toMatchObject({
      response: { code: 'automation_owner_no_access' },
    });
  });
});

describe('what a refusal stops, and what it must not (ticket #1353)', () => {
  it('the refused action stops the rule: the action after it never runs', async () => {
    const f = await fixture();
    const person = await maker(f, 'Stopper');
    const rule = await newRule(person, f, [{ type: 'set_values', values: { [f.statusApi]: 'first' } }, { type: 'add_comment', body_template: 'SECOND RAN' }]);
    await degrade(person, 'viewer');
    const rec = await order(f, false);
    const run = await fire(f, rule.id, rec.id);
    expect(run.status).toBe('error');
    expect(await statusOf(f, f.orders, rec.id)).toBeFalsy();
    const comments = (await asAdmin('GET', `/workspaces/${wsId}/databases/${f.orders}/records/${rec.id}/comments`)).json().data as unknown[];
    expect(comments).toHaveLength(0);
  });

  it('a rule with no owner is refused (automation_owner_missing), whatever the action', async () => {
    const f = await fixture();
    const person = await maker(f, 'Soon ownerless');
    const rule = await newRule(person, f, [{ type: 'set_values', values: { [f.statusApi]: 'done' } }]);
    await db.update(automations).set({ createdBy: null }).where(eq(automations.id, rule.id));
    const rec = await order(f, false);
    const run = await fire(f, rule.id, rec.id);
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/^automation_owner_missing: /);
    expect(run.error).toContain('no owner');
    expect(await statusOf(f, f.orders, rec.id)).toBeFalsy();
  });

  it('a rule whose owner still has access runs exactly as before (an admin-built rule is untouched)', async () => {
    const f = await fixture();
    const rule = await (async () => {
      const res = await asAdmin('POST', `/workspaces/${wsId}/databases/${f.orders}/automations`, {
        name: 'admin rule',
        trigger: { type: 'record_updated', field_id: f.notesField },
        actions: [{ type: 'set_values', values: { [f.statusApi]: 'done' } }, { type: 'create_record', database_id: f.targets, values: { name: 'Admin made' } }],
      });
      return res.json() as { id: string };
    })();
    const rec = await order(f, false);
    const run = await fire(f, rule.id, rec.id);
    expect(run.status, run.error ?? '').toBe('ok');
    expect(await statusOf(f, f.orders, rec.id)).toBe('done');
    expect(await countIn(f.targets, 'Admin made')).toBe(1);
  });
});

describe('who a run is attributed to (ticket #1353)', () => {
  it('a button press runs as the PRESSER (an editor, not a rule builder), and its outward action is not held to the rule-builder rung', async () => {
    const f = await fixture();
    const presser = await joinAs(app, admin.token, wsId, 'The Presser', 'member', [{ database_id: f.orders, role: 'editor' }]);
    const button = (
      await asAdmin('POST', `/workspaces/${wsId}/databases/${f.orders}/fields`, {
        display_name: 'Mark done',
        type: 'button',
        config: { actions: [{ type: 'set_values', values: { [f.statusApi]: 'pressed' } }, { type: 'send_slack_message', channel: '#general', text: 'pressed', require_approval: false }] },
      })
    ).json().id as string;
    const rec = await order(f, false);
    const started = new Date();
    const res = await as(presser.token, 'POST', `/workspaces/${wsId}/databases/${f.orders}/records/${rec.id}/buttons/${button}/press`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    const effects = res.json().effects as Array<{ type: string }>;
    expect(effects.map((e) => e.type)).toEqual(['set_values', 'send_slack_message']);
    expect(await statusOf(f, f.orders, rec.id)).toBe('pressed');
    const events = (await db.select().from(activityEvents).where(eq(activityEvents.recordId, rec.id))).filter((e) => e.createdAt >= started);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.actorId).toBe(presser.id);
  });
});

describe('the other ways a rule starts (ticket #1353)', () => {
  it('a webhook-triggered run re-checks its owner: runs while they are a member, refused once they have left', async () => {
    const f = await fixture();
    const person = await maker(f, 'Hook owner');
    const rule = await newRule(person, f, [{ type: 'create_record', database_id: f.targets, values: { name: 'From hook' } }], { type: 'webhook_received' });
    const [row] = await db.select().from(automations).where(eq(automations.id, rule.id));
    const rule4 = { id: row!.id, databaseId: row!.databaseId, actions: row!.actions, createdBy: row!.createdBy };

    const ok = engine.startHookRun(rule4, wsId, { a: 1 });
    await engine.settleHook(ok);
    expect((await db.select().from(automationRuns).where(eq(automationRuns.id, ok)))[0]!.status).toBe('ok');
    expect(await countIn(f.targets, 'From hook')).toBe(1);

    await degrade(person, 'left');
    const refused = engine.startHookRun(rule4, wsId, { a: 2 });
    await engine.settleHook(refused);
    const run = (await db.select().from(automationRuns).where(eq(automationRuns.id, refused)))[0]!;
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/^automation_owner_missing: /);
    expect(await countIn(f.targets, 'From hook')).toBe(1);
  });

  it('a scheduled run re-checks its owner too', async () => {
    const f = await fixture();
    const person = await maker(f, 'Schedule owner');
    const rule = await newRule(person, f, [{ type: 'add_comment', body_template: 'swept' }], { type: 'schedule', every: 'day', at: '09:00' });
    await degrade(person, 'viewer');
    const rec = await order(f, false);
    await db.update(automations).set({ nextDueAt: new Date(Date.now() - 1000) }).where(eq(automations.id, rule.id));
    await engine.tick();
    const deadline = Date.now() + 10_000;
    let runs = await runsOf(rule.id);
    while (runs.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      runs = await runsOf(rule.id);
    }
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.status !== 'ok')).toBe(true);
    expect(runs.some((r) => /^automation_owner_no_access: /.test(r.error ?? ''))).toBe(true);
    const comments = (await asAdmin('GET', `/workspaces/${wsId}/databases/${f.orders}/records/${rec.id}/comments`)).json().data as unknown[];
    expect(comments).toHaveLength(0);
  });
});

describe('a queued action is re-checked when its job is CLAIMED, and never retried (ticket #1353)', () => {
  it('an owner who leaves between queueing and sending: the job fails once with the refusal, attempts stay 0, nothing is sent', async () => {
    const f = await fixture();
    const person = await maker(f, 'Queue owner');
    const rule = await newRule(person, f, [{ type: 'http_request', method: 'POST', url: 'https://example.invalid/hook' }]);
    const rec = await order(f, false);
    const run = await fire(f, rule.id, rec.id);
    expect(run.status, run.error ?? '').toBe('ok');
    const [queued] = await db.select().from(automationJobs).where(eq(automationJobs.ruleId, rule.id));
    expect(queued!.status).toBe('queued');

    await degrade(person, 'left');
    await jobs.tick();
    const [after] = await db.select().from(automationJobs).where(eq(automationJobs.id, queued!.id));
    expect(after!.status).toBe('failed');
    expect(after!.attempts).toBe(0);
    expect(after!.lastError).toMatch(/^automation_owner_missing: /);
    // Terminal: a second pass does not touch it.
    await jobs.tick();
    const [again] = await db.select().from(automationJobs).where(eq(automationJobs.id, queued!.id));
    expect(again!.status).toBe('failed');
    expect(again!.attempts).toBe(0);
  });
});

describe('ownerMissing on the rule (ticket #1353)', () => {
  it('is true for a rule whose owner left or is null, false otherwise, on list, create and update', async () => {
    const f = await fixture();
    const stays = await maker(f, 'Stays');
    const leaves = await maker(f, 'Leaves');
    const actions = [{ type: 'add_comment', body_template: 'x' }];
    const fine = await newRule(stays, f, actions);
    const gone = await newRule(leaves, f, actions);
    const nobody = await newRule(stays, f, actions);
    await db.update(automations).set({ createdBy: null }).where(eq(automations.id, nobody.id));

    const created = await as(stays.token, 'POST', `/workspaces/${wsId}/databases/${f.orders}/automations`, { name: 'fresh', trigger: { type: 'record_created' }, actions });
    expect(created.json().ownerMissing).toBe(false);

    const list = async () => ((await asAdmin('GET', `/workspaces/${wsId}/databases/${f.orders}/automations`)).json().data as Array<{ id: string; ownerMissing: boolean }>);
    let byId = new Map((await list()).map((r) => [r.id, r.ownerMissing]));
    expect(byId.get(fine.id)).toBe(false);
    expect(byId.get(gone.id)).toBe(false);
    expect(byId.get(nobody.id)).toBe(true);

    await degrade(leaves, 'left');
    byId = new Map((await list()).map((r) => [r.id, r.ownerMissing]));
    expect(byId.get(gone.id)).toBe(true);
    expect(byId.get(fine.id)).toBe(false);

    // An admin handing the rule to themselves (a PATCH does not change the owner), the flag is read fresh, never stored.
    const patched = await asAdmin('PATCH', `/workspaces/${wsId}/databases/${f.orders}/automations/${gone.id}`, { enabled: false });
    expect(patched.json().ownerMissing).toBe(true);
  });
});
