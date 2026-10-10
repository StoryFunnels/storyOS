import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';

/**
 * #231 — validation rules BLOCK a record write when the data it would leave behind is not valid.
 *
 * Otto's rulings, each pinned here:
 *   - a rule applies to EVERYONE, admins and people in the web app included, with no bypass;
 *   - it fires only when a field it REFERENCES changed (a rule added to a database of non-conforming rows must not
 *     make those rows uneditable);
 *   - invalid data therefore persists silently, so it must be VISIBLE on read: the violations endpoint.
 */
let app: NestFastifyApplication;
let engine: AutomationsService;
let owner: { token: string; email: string };
let member: { token: string; email: string };
let guest: { token: string; email: string };
let ws: string;
let tasks: string;
let other: string;
let status: string; // api_name
let statusId: string;
let summary: string;
let reason: string;
let todoOpt: string;
let doneOpt: string;
let blockedOpt: string;
let preDone: string; // created BEFORE any rule: Done with an empty summary
let preBlocked: string; // created BEFORE any rule: Blocked with no reason
let preDone2: string; // the same shape, left untouched by every other test: the one the violations report must list

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const base = () => `/workspaces/${ws}/databases/${tasks}`;
const rec = (id: string) => `${base()}/records/${id}`;
const mk = async (values: Record<string, unknown>, token = owner.token) => as(token, 'POST', `${base()}/records`, { values });
const patch = (id: string, values: Record<string, unknown>, token = owner.token) => as(token, 'PATCH', rec(id), { values });
const declare = (body: Record<string, unknown>, token = owner.token) => as(token, 'POST', `${base()}/validation-rules`, body);
const get = async (id: string) => (await as(owner.token, 'GET', rec(id))).json();
const runs = async (ruleId: string) => (await as(owner.token, 'GET', `${base()}/automations/${ruleId}/runs`)).json().data as unknown[];

async function join(user: { token: string; email: string }, role: 'member' | 'guest', grants?: unknown[]) {
  const inv = await as(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: user.email, role, ...(grants ? { grants } : {}) });
  expect(inv.statusCode, inv.body).toBe(201);
  const ok = await as(user.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  expect(ok.statusCode, ok.body).toBe(201);
}

beforeAll(async () => {
  app = await createTestApp();
  engine = app.get(AutomationsService);
  owner = await signUpUser(app, 'VR Owner');
  member = await signUpUser(app, 'VR Member');
  guest = await signUpUser(app, 'VR Guest');
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'VR WS' })).json().id;
  const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  other = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Notes' })).json().id;
  const st = (await as(owner.token, 'POST', `${base()}/fields`, {
    display_name: 'Status', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'Done' }, { label: 'Blocked' }],
  })).json();
  status = st.apiName;
  statusId = st.id;
  const opt = (label: string) => st.options.find((o: { label: string }) => o.label === label).id as string;
  [todoOpt, doneOpt, blockedOpt] = [opt('Todo'), opt('Done'), opt('Blocked')];
  summary = (await as(owner.token, 'POST', `${base()}/fields`, { display_name: 'Summary', type: 'text', config: {} })).json().apiName;
  reason = (await as(owner.token, 'POST', `${base()}/fields`, { display_name: 'Reason', type: 'text', config: {} })).json().apiName;
  await as(owner.token, 'POST', `${base()}/fields`, { display_name: 'Deadline', type: 'date', config: {} });

  // Written BEFORE any rule exists: non-conforming data a rule must not strand.
  preDone = (await mk({ name: 'Old done, no summary', [status]: doneOpt })).json().id;
  preBlocked = (await mk({ name: 'Old blocked, no reason', [status]: blockedOpt })).json().id;
  preDone2 = (await mk({ name: 'Legacy done, no summary', [status]: doneOpt })).json().id;

  await join(member, 'member');
  await join(guest, 'guest', [{ database_id: tasks, role: 'editor' }]);
}, 240_000);

afterAll(async () => { await app.close(); });

describe('#231 declaring rules', () => {
  it('only an admin may declare, read or delete; a member, a guest and a bound token are refused', async () => {
    const body = { name: 'x', trigger: 'create', condition: { field: summary, op: 'not_empty' }, message: 'm' };
    expect((await declare(body, member.token)).statusCode).toBe(403);
    expect((await declare(body, guest.token)).statusCode).toBe(403);
    expect((await as(member.token, 'GET', `${base()}/validation-rules`)).statusCode).toBe(403);
    const bound = (await as(owner.token, 'POST', '/me/tokens', { name: 'b', workspace_id: ws, resource_scope: { database_ids: [tasks] } })).json().token;
    expect((await declare(body, bound)).statusCode).toBe(403);
  });

  it('refuses a condition on a field that does not exist, naming it', async () => {
    const res = await declare({ name: 'x', trigger: 'create', condition: { field: 'nope', op: 'not_empty' }, message: 'm' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('nope');
  });

  it('refuses a computed field in a condition, because there is nothing to check yet', async () => {
    const f = await as(owner.token, 'POST', `${base()}/fields`, { display_name: 'Calc', type: 'formula', config: { expression: '1 + 1' } });
    expect(f.statusCode, f.body).toBe(201);
    const res = await declare({ name: 'x', trigger: 'create', condition: { field: f.json().apiName, op: 'eq', value: 2 }, message: 'm' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('formula');
  });

  it('a transition rule needs {field, to}; a bad option is refused listing the options', async () => {
    const missing = await declare({ name: 'x', trigger: 'transition', condition: { field: summary, op: 'not_empty' }, message: 'm' });
    expect(missing.statusCode).toBe(422);
    const bad = await declare({ name: 'x', trigger: 'transition', transition: { field: status, to: 'Archived' }, condition: { field: summary, op: 'not_empty' }, message: 'm' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toContain('Todo, Done, Blocked');
  });
});

describe('#231 editing a rule: a body with nothing editable is a 422 that says what can be edited, never a 500', () => {
  it.each([{}, { unknown: 1 }, { trigger: 'create' }, { name: 'ok', trigger: 'update' }])('PATCH %j', async (body) => {
    const made = await declare({ name: 'edit me', trigger: 'create', condition: { field: summary, op: 'not_empty' }, message: 'm' });
    expect(made.statusCode, made.body).toBe(201);
    const res = await as(owner.token, 'PATCH', `${base()}/validation-rules/${made.json().id}`, body);
    expect(res.statusCode, res.body).toBe(422);
    expect(JSON.stringify(res.json())).toMatch(/nothing to change|Unrecognized key|trigger/i);
    await as(owner.token, 'DELETE', `${base()}/validation-rules/${made.json().id}`);
  });

  it('name, message, enabled and condition alone are still accepted', async () => {
    const made = (await declare({ name: 'edit me too', trigger: 'create', condition: { field: summary, op: 'not_empty' }, message: 'm' })).json();
    for (const body of [{ name: 'n2' }, { message: 'm2' }, { enabled: false }, { condition: { field: summary, op: 'is_empty' } }]) {
      expect((await as(owner.token, 'PATCH', `${base()}/validation-rules/${made.id}`, body)).statusCode, JSON.stringify(body)).toBe(200);
    }
    await as(owner.token, 'DELETE', `${base()}/validation-rules/${made.id}`);
  });
});

describe('#231 a transition rule: Done requires a summary', () => {
  let ruleId: string;
  beforeAll(async () => {
    const res = await declare({
      name: 'Done needs a summary', trigger: 'transition', transition: { field: status, to: 'Done' },
      condition: { field: summary, op: 'not_empty' }, message: 'Add a summary before marking a task Done',
    });
    expect(res.statusCode, res.body).toBe(201);
    ruleId = res.json().id;
  });

  it('blocks the transition with the rule\'s own message, and the change is NOT persisted', async () => {
    const t = (await mk({ name: 'Task A', [status]: todoOpt })).json().id as string;
    const res = await patch(t, { [status]: doneOpt });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toBe('Add a summary before marking a task Done');
    expect(JSON.stringify(res.json().error.details)).toContain('Done needs a summary');
    expect((await get(t)).values[status]).toBe(todoOpt);
  });

  it('passes when the condition holds, in the same write or already stored', async () => {
    const t = (await mk({ name: 'Task B', [status]: todoOpt })).json().id as string;
    expect((await patch(t, { [status]: doneOpt, [summary]: 'shipped' })).statusCode).toBe(200);
    const u = (await mk({ name: 'Task C', [status]: todoOpt, [summary]: 'ready' })).json().id as string;
    expect((await patch(u, { [status]: doneOpt })).statusCode).toBe(200);
  });

  it('NON-RETROACTIVE: a record already Done with no summary stays editable; only the transition is judged', async () => {
    expect((await patch(preDone, { name: 'Old done, renamed' })).statusCode).toBe(200);
    expect((await patch(preDone, { [reason]: 'a note' })).statusCode).toBe(200);
    // moving it away and back is a transition TO Done, so it is judged
    expect((await patch(preDone, { [status]: todoOpt })).statusCode).toBe(200);
    expect((await patch(preDone, { [status]: doneOpt })).statusCode).toBe(422);
  });

  it('a record CREATED already holding the target is judged too', async () => {
    const res = await mk({ name: 'Born done', [status]: doneOpt });
    expect(res.statusCode, res.body).toBe(422);
    expect((await mk({ name: 'Born done ok', [status]: doneOpt, [summary]: 's' })).statusCode).toBe(201);
  });

  it('NO ADMIN BYPASS, and no exemption for any writer: admin, member, guest, an agent token and an API token are all refused', async () => {
    const t = (await mk({ name: 'Task D', [status]: todoOpt })).json().id as string;
    for (const token of [owner.token, member.token, guest.token]) {
      const res = await patch(t, { [status]: doneOpt }, token);
      expect(res.statusCode, `${token.slice(0, 6)}: ${res.body}`).toBe(422);
    }
    const adminPat = (await as(owner.token, 'POST', '/me/tokens', { name: 'p', workspace_id: ws, scope: 'admin' })).json().token as string;
    expect((await patch(t, { [status]: doneOpt }, adminPat)).statusCode).toBe(422);
    expect((await as(owner.token, 'PATCH', `${base()}/records/batch`, { record_ids: [t], values: { [status]: doneOpt } })).json().failed).toHaveLength(1);
    expect((await get(t)).values[status]).toBe(todoOpt);
  });

  it('a batch update reports the refused records by id with the rule\'s message and updates the rest', async () => {
    const ok = (await mk({ name: 'Task E', [status]: todoOpt, [summary]: 'ok' })).json().id as string;
    const bad = (await mk({ name: 'Task F', [status]: todoOpt })).json().id as string;
    const res = (await as(owner.token, 'PATCH', `${base()}/records/batch`, { record_ids: [ok, bad], values: { [status]: doneOpt } })).json();
    expect(res.updated).toBe(1);
    expect(res.failed).toEqual([{ record_id: bad, message: 'Add a summary before marking a task Done' }]);
  });

  it('restoring an old snapshot is a write like any other: it cannot be a way around the rule', async () => {
    // preDone's history now has a snapshot of its Done/empty-summary state from the rename above
    await patch(preDone, { [status]: todoOpt });
    const versions = (await as(owner.token, 'GET', `${rec(preDone)}/versions`)).json().data as Array<{ id: string }>;
    let refused = 0;
    for (const v of versions) {
      const r = await as(owner.token, 'POST', `${rec(preDone)}/versions/${v.id}/restore`);
      if (r.statusCode === 422) refused += 1;
    }
    expect(refused).toBeGreaterThanOrEqual(1);
  });

  it('a rule on one database does not touch another', async () => {
    expect((await as(owner.token, 'POST', `/workspaces/${ws}/databases/${other}/records`, { values: { name: 'plain' } })).statusCode).toBe(201);
  });

  it('a disabled rule enforces nothing; re-enabling restores it', async () => {
    expect((await as(owner.token, 'PATCH', `${base()}/validation-rules/${ruleId}`, { enabled: false })).statusCode).toBe(200);
    const t = (await mk({ name: 'Task G', [status]: todoOpt })).json().id as string;
    expect((await patch(t, { [status]: doneOpt })).statusCode).toBe(200);
    await as(owner.token, 'PATCH', `${base()}/validation-rules/${ruleId}`, { enabled: true });
    const u = (await mk({ name: 'Task H', [status]: todoOpt })).json().id as string;
    expect((await patch(u, { [status]: doneOpt })).statusCode).toBe(422);
  });

  it('a refused update fires NO dependent automation; an allowed one does', async () => {
    const auto = await as(owner.token, 'POST', `${base()}/automations`, {
      name: 'comment on status change', trigger: { type: 'record_updated', field_id: statusId },
      actions: [{ type: 'add_comment', body_template: 'status moved' }],
    });
    expect(auto.statusCode, auto.body).toBe(201);
    const autoId = auto.json().id as string;
    const t = (await mk({ name: 'Task I', [status]: todoOpt })).json().id as string;
    const before = (await runs(autoId)).length;
    expect((await patch(t, { [status]: doneOpt })).statusCode).toBe(422);
    await engine.settle(t);
    expect((await runs(autoId)).length, 'a refused write must not fire the automation').toBe(before);
    expect((await patch(t, { [status]: doneOpt, [summary]: 'done' })).statusCode).toBe(200);
    await engine.settle(t);
    expect((await runs(autoId)).length, 'the allowed write fires it').toBe(before + 1);
  });

  it('an AUTOMATION that writes through the same path is refused by the rule: its run fails and the record is unchanged', async () => {
    const reasonId = (await as(owner.token, 'GET', base())).json().fields.find((f: { apiName: string }) => f.apiName === reason).id as string;
    const auto = await as(owner.token, 'POST', `${base()}/automations`, {
      name: 'mark done when a reason is written', trigger: { type: 'record_updated', field_id: reasonId },
      actions: [{ type: 'set_values', values: { [status]: doneOpt } }],
    });
    expect(auto.statusCode, auto.body).toBe(201);
    const autoId = auto.json().id as string;
    const t = (await mk({ name: 'Task J', [status]: todoOpt })).json().id as string;
    expect((await patch(t, { [reason]: 'trigger it' })).statusCode).toBe(200);
    await engine.settle(t);
    const history = (await runs(autoId)) as Array<{ status: string; error?: string }>;
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.some((r) => r.status === 'ok'), 'the automation must NOT have been able to write past the rule').toBe(false);
    expect((await get(t)).values[status]).toBe(todoOpt);
    await as(owner.token, 'DELETE', `${base()}/automations/${autoId}`);
  });
});

describe('#231 a create rule, and a batch is all-or-nothing', () => {
  it('blocks a create missing the required field; a batch with one bad row creates NOTHING', async () => {
    const res = await declare({ name: 'Needs a deadline', trigger: 'create', condition: { field: 'deadline', op: 'not_empty' }, message: 'Every task needs a deadline' });
    expect(res.statusCode, res.body).toBe(201);
    const bad = await mk({ name: 'No deadline' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toBe('Every task needs a deadline');
    const count = async () => (await as(owner.token, 'POST', `${base()}/records/aggregate`, { op: 'count' })).json().value as number;
    const before = await count();
    const batch = await as(owner.token, 'POST', `${base()}/records/batch`, {
      records: [{ values: { name: 'ok row', deadline: '2026-12-01' } }, { values: { name: 'bad row' } }],
    });
    expect(batch.statusCode, batch.body).toBe(422);
    expect(await count(), 'nothing from the batch may be persisted').toBe(before);
    expect((await mk({ name: 'with deadline', deadline: '2026-12-01' })).statusCode).toBe(201);
  });
});

describe('#231 an update rule fires ONLY when a field it references changed (cross-field, pre-existing violations)', () => {
  beforeAll(async () => {
    const res = await declare({
      name: 'Blocked needs a reason', trigger: 'update', message: 'Say why it is blocked',
      condition: { or: [{ field: status, op: 'has_none', value: [blockedOpt] }, { field: reason, op: 'not_empty' }] },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('an UNRELATED edit to a record that already breaks the rule is NOT blocked (it would be permanently uneditable)', async () => {
    expect((await patch(preBlocked, { name: 'Old blocked, renamed' })).statusCode).toBe(200);
    expect((await patch(preBlocked, { [summary]: 'a summary' })).statusCode).toBe(200);
  });

  it('a change to a field it READS or is ABOUT is judged: either side of the cross-field rule', async () => {
    const t = (await mk({ name: 'Task K', deadline: '2026-12-01', [status]: todoOpt })).json().id as string;
    expect((await patch(t, { [status]: blockedOpt })).statusCode).toBe(422); // the status moved to Blocked with no reason
    expect((await patch(t, { [status]: blockedOpt, [reason]: 'waiting on legal' })).statusCode).toBe(200);
    expect((await patch(t, { [reason]: null })).statusCode).toBe(422); // the reason moved, status still Blocked
    expect((await patch(t, { [reason]: 'new reason' })).statusCode).toBe(200);
    // fixing a pre-existing violation is allowed
    expect((await patch(preBlocked, { [reason]: 'finally explained' })).statusCode).toBe(200);
  });
});

describe('#231 SURFACE ON READ: existing violations are visible', () => {
  it('lists the stored records that break each rule, with a count, and the count drops when one is fixed', async () => {
    const list = (await as(owner.token, 'GET', `${base()}/validation-rules`)).json().data as Array<{ id: string; name: string; violation_count: number; dangling: boolean; trigger: string }>;
    const blocked = list.find((r) => r.name === 'Blocked needs a reason')!;
    const done = list.find((r) => r.name === 'Done needs a summary')!;
    expect(done.violation_count).toBeGreaterThanOrEqual(1); // preDone2: Done, no summary, never touched
    const v = (await as(owner.token, 'GET', `${base()}/validation-rules/${done.id}/violations`)).json();
    expect(v.data.map((r: { id: string }) => r.id)).toContain(preDone2);
    expect(v.count).toBe(done.violation_count);
    expect(JSON.stringify(v.data)).toContain('Legacy done');
    // preBlocked was fixed above, so the blocked rule no longer lists it
    const bv = (await as(owner.token, 'GET', `${base()}/validation-rules/${blocked.id}/violations`)).json();
    expect(bv.data.map((r: { id: string }) => r.id)).not.toContain(preBlocked);
    // adding the summary (NOT a transition, so it is allowed) fixes the violation, and the count drops by exactly one
    expect((await patch(preDone2, { [summary]: 'now it has one' })).statusCode).toBe(200);
    const after = (await as(owner.token, 'GET', `${base()}/validation-rules/${done.id}/violations`)).json();
    expect(after.count).toBe(done.violation_count - 1);
    expect(after.data.map((r: { id: string }) => r.id)).not.toContain(preDone2);
  });

  it('only an admin can read violations (they carry record titles)', async () => {
    const list = (await as(owner.token, 'GET', `${base()}/validation-rules`)).json().data as Array<{ id: string }>;
    expect((await as(member.token, 'GET', `${base()}/validation-rules/${list[0]!.id}/violations`)).statusCode).toBe(403);
  });

  it('a rule whose field was DELETED is dangling: skipped (no lockout), flagged, and not checkable', async () => {
    const f = (await as(owner.token, 'POST', `${base()}/fields`, { display_name: 'Temp', type: 'text', config: {} })).json();
    const r = await declare({ name: 'Temp required', trigger: 'create', condition: { field: f.apiName, op: 'not_empty' }, message: 'temp needed' });
    expect(r.statusCode, r.body).toBe(201);
    const ruleId = r.json().id as string;
    expect((await mk({ name: 'x', deadline: '2026-12-01' })).statusCode).toBe(422); // the rule bites while its field exists
    expect((await as(owner.token, 'DELETE', `${base()}/fields/${f.id}`)).statusCode).toBeLessThan(300);
    expect((await mk({ name: 'x2', deadline: '2026-12-01' })).statusCode, 'a dangling rule must not lock every write').toBe(201);
    const list = (await as(owner.token, 'GET', `${base()}/validation-rules`)).json().data as Array<{ id: string; dangling: boolean; violation_count: number | null }>;
    const mine = list.find((x) => x.id === ruleId)!;
    expect(mine.dangling).toBe(true);
    expect(mine.violation_count).toBeNull();
    expect((await as(owner.token, 'GET', `${base()}/validation-rules/${ruleId}/violations`)).statusCode).toBe(422);
  });
});

/**
 * #231 (Otto's ruling on Vera's finding): a rule must never go SILENTLY ineffective. A field type change, or deleting an
 * option, while an ENABLED rule depends on it is REFUSED naming the rules; an explicit confirm lets it proceed; and then
 * the rule is shown NOT CHECKABLE, never left displaying as enabled while enforcing nothing. This is the same
 * refuse-unless-confirmed pattern removeOption already uses for an option records still hold, extended to "a rule depends
 * on this".
 */
describe('#231 a rule can never silently stop enforcing', () => {
  async function fixture(label: string) {
    const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
    const db = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: `Gated ${label}` })).json().id as string;
    const b = `/workspaces/${ws}/databases/${db}`;
    const stage = (await as(owner.token, 'POST', `${b}/fields`, {
      display_name: 'Stage', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'Done' }, { label: 'Extra' }],
    })).json();
    const opt = (l: string) => stage.options.find((o: { label: string }) => o.label === l).id as string;
    const sum = (await as(owner.token, 'POST', `${b}/fields`, { display_name: 'Summary', type: 'text', config: {} })).json();
    const note = (await as(owner.token, 'POST', `${b}/fields`, { display_name: 'Note', type: 'text', config: {} })).json();
    const t = (await as(owner.token, 'POST', `${b}/validation-rules`, {
      name: 'T: Done needs a summary', trigger: 'transition', transition: { field: stage.apiName, to: 'Done' },
      condition: { field: sum.apiName, op: 'not_empty' }, message: 'Add a summary',
    })).json();
    const u = (await as(owner.token, 'POST', `${b}/validation-rules`, {
      name: 'U: Extra needs a note', trigger: 'update', message: 'Say why',
      condition: { or: [{ field: stage.apiName, op: 'has_none', value: [opt('Extra')] }, { field: note.apiName, op: 'not_empty' }] },
    })).json();
    expect(t.id, JSON.stringify(t)).toBeTruthy();
    expect(u.id, JSON.stringify(u)).toBeTruthy();
    const rules = async () => ((await as(owner.token, 'GET', `${b}/validation-rules`)).json().data as Array<Record<string, any>>);
    const write = (values: Record<string, unknown>) => as(owner.token, 'POST', `${b}/records`, { values });
    return { b, stage, sum, note, t, u, opt, rules, write };
  }

  it('(a) a LOSSLESS type change (select -> text): the dry run names the rules, the apply is refused, a confirm proceeds', async () => {
    const f = await fixture('a');
    const dry = await as(owner.token, 'POST', `${f.b}/fields/${f.stage.id}/change-type`, { type: 'text', dry_run: true });
    expect(dry.statusCode, dry.body).toBeLessThan(300);
    expect(dry.json().lossy_conversions).toBe(0);
    expect((dry.json().dependent_rules as Array<{ name: string; breaks: boolean }>).map((d) => [d.name, d.breaks]).sort()).toEqual([
      ['T: Done needs a summary', true], ['U: Extra needs a note', true],
    ]);
    const refused = await as(owner.token, 'POST', `${f.b}/fields/${f.stage.id}/change-type`, { type: 'text' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.message).toContain('T: Done needs a summary');
    expect(refused.json().error.message).toContain('U: Extra needs a note');
    expect((await as(owner.token, 'GET', f.b)).json().fields.find((x: { id: string }) => x.id === f.stage.id).type, 'a refused change changes nothing').toBe('select');
    const ok = await as(owner.token, 'POST', `${f.b}/fields/${f.stage.id}/change-type`, { type: 'text', confirm_dependent_rules: true });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    // (f) the rules are now shown NOT CHECKABLE, not as enforcing; the violations read says so instead of returning 0
    for (const r of await f.rules()) {
      expect(r.status, r.name).toBe('not_checkable');
      expect(r.not_checkable, r.name).toBeTruthy();
      expect(r.violation_count, 'never a misleading 0').toBeNull();
      const v = await as(owner.token, 'GET', `${f.b}/validation-rules/${r.id}/violations`);
      expect(v.statusCode).toBe(422);
      expect(v.json().error.message).toContain('NOT CHECKABLE');
    }
    // and it cannot be re-enabled or re-conditioned as if it worked
    const again = await as(owner.token, 'PATCH', `${f.b}/validation-rules/${f.t.id}`, { enabled: true });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toContain('cannot be checked');
    // nothing is locked: writes still go through while the rules are unable to enforce
    expect((await f.write({ name: 'x', stage: 'whatever' })).statusCode).toBe(201);
  });

  it('(a) a LOSSY change (text -> date with a value that does not parse): the lossy count AND the dependent rule are both reported, and refused', async () => {
    const f = await fixture('a2');
    const lossyRule = await as(owner.token, 'POST', `${f.b}/validation-rules`, {
      name: 'L: note must mention ship', trigger: 'update', message: 'mention ship', condition: { field: f.note.apiName, op: 'contains', value: 'ship' },
    });
    expect(lossyRule.statusCode, lossyRule.body).toBe(201);
    expect((await f.write({ name: 'r', [f.note.apiName]: 'we ship soon', stage: undefined })).statusCode).toBe(201);
    const dry = await as(owner.token, 'POST', `${f.b}/fields/${f.note.id}/change-type`, { type: 'date', dry_run: true });
    expect(dry.statusCode, dry.body).toBeLessThan(300);
    expect(dry.json().lossy_conversions).toBeGreaterThanOrEqual(1);
    expect((dry.json().dependent_rules as Array<{ name: string; breaks: boolean }>).some((d) => d.name.startsWith('L:') && d.breaks)).toBe(true);
    const refused = await as(owner.token, 'POST', `${f.b}/fields/${f.note.id}/change-type`, { type: 'date' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('L: note must mention ship');
  });

  it('a change the rule SURVIVES is not refused: select -> workflow keeps a transition rule enforcing', async () => {
    const f = await fixture('a3');
    const dry = await as(owner.token, 'POST', `${f.b}/fields/${f.stage.id}/change-type`, { type: 'workflow', dry_run: true });
    expect((dry.json().dependent_rules as Array<{ breaks: boolean }>).every((d) => !d.breaks)).toBe(true);
    expect((await as(owner.token, 'POST', `${f.b}/fields/${f.stage.id}/change-type`, { type: 'workflow' })).statusCode).toBeLessThan(300);
    for (const r of await f.rules()) expect(r.status, r.name).toBe('enforcing');
    expect((await f.write({ name: 'still blocked', [f.stage.apiName]: f.opt('Done') })).statusCode).toBe(422);
  });

  it('(b) deleting the option a transition rule names is REFUSED naming the rule, even if no record uses it; a confirm proceeds and the rule is marked', async () => {
    const f = await fixture('b');
    const refused = await as(owner.token, 'DELETE', `${f.b}/fields/${f.stage.id}/options/${f.opt('Done')}`, { confirm: true });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.message).toContain('T: Done needs a summary');
    // an option named only inside another rule's CONDITION is protected the same way
    const extra = await as(owner.token, 'DELETE', `${f.b}/fields/${f.stage.id}/options/${f.opt('Extra')}`, { confirm: true });
    expect(extra.statusCode).toBe(409);
    expect(extra.json().error.message).toContain('U: Extra needs a note');
    const ok = await as(owner.token, 'DELETE', `${f.b}/fields/${f.stage.id}/options/${f.opt('Done')}`, { confirm: true, confirm_dependent_rules: true });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    const t = (await f.rules()).find((r) => r.id === f.t.id)!;
    expect(t.status).toBe('not_checkable');
    expect(t.not_checkable).toContain('no longer exists');
  });

  it('(c) RENAMING that option is not refused and the rule keeps enforcing (it stores the option ID); the new label shows', async () => {
    const f = await fixture('c');
    const rename = await as(owner.token, 'PATCH', `${f.b}/fields/${f.stage.id}/options/${f.opt('Done')}`, { label: 'Complete' });
    expect(rename.statusCode, rename.body).toBe(200);
    const t = (await f.rules()).find((r) => r.id === f.t.id)!;
    expect(t.status).toBe('enforcing');
    expect(t.transition.to).toBe('Complete');
    expect((await f.write({ name: 'x', [f.stage.apiName]: f.opt('Done') })).statusCode, 'the rule still bites after the rename').toBe(422);
  });

  it('(d) RENAMING a field a rule references changes its display name only: the api_name is stable and the rule keeps enforcing', async () => {
    const f = await fixture('d');
    const rename = await as(owner.token, 'PATCH', `${f.b}/fields/${f.stage.id}`, { display_name: 'Phase' });
    expect(rename.statusCode, rename.body).toBe(200);
    expect(rename.json().apiName, 'a rename must not change the api_name rules are stored against').toBe(f.stage.apiName);
    for (const r of await f.rules()) expect(r.status, r.name).toBe('enforcing');
    expect((await f.write({ name: 'x', [f.stage.apiName]: f.opt('Done') })).statusCode).toBe(422);
  });

  it('a rule that is ALREADY not checkable does not block retyping a field it reads: only rules this change would break are named', async () => {
    const f = await fixture('g');
    // C reads Summary with an operator that only fits text
    const c = await as(owner.token, 'POST', `${f.b}/validation-rules`, {
      name: 'C: summary mentions ship', trigger: 'update', message: 'mention ship', condition: { field: f.sum.apiName, op: 'contains', value: 'ship' },
    });
    expect(c.statusCode, c.body).toBe(201);
    // make T (which also reads Summary) not checkable for ITS OWN reason: its option is gone
    const gone = await as(owner.token, 'DELETE', `${f.b}/fields/${f.stage.id}/options/${f.opt('Done')}`, { confirm: true, confirm_dependent_rules: true });
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    const refused = await as(owner.token, 'POST', `${f.b}/fields/${f.sum.id}/change-type`, { type: 'date' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.message).toContain('C: summary mentions ship');
    expect(refused.json().error.message, 'T was already not checkable for another reason and is not named').not.toContain('T: Done needs a summary');
    expect(refused.json().error.message).toContain('not available over MCP');
  });

  it('a DISABLED rule is not a dependent: it does not block the change', async () => {
    const f = await fixture('e');
    await as(owner.token, 'PATCH', `${f.b}/validation-rules/${f.t.id}`, { enabled: false });
    await as(owner.token, 'PATCH', `${f.b}/validation-rules/${f.u.id}`, { enabled: false });
    expect((await as(owner.token, 'POST', `${f.b}/fields/${f.stage.id}/change-type`, { type: 'text' })).statusCode).toBeLessThan(300);
  });
});
