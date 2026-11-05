import { automationTriggerSchema, createAutomationSchema, planAgentSchema, scheduleProblems } from '@storyos/schemas';
import { describe, expect, it } from 'vitest';
import { canBindAgentToAssignment, canDeclareWriteGates, canHireAgents } from './access';
import {
  ASKS,
  DEFAULT_AGENT_JOB,
  DEFAULT_AGENT_NAME,
  DEFAULT_ASKS,
  executeHire,
  hireCalls,
  hireOutcomeMessage,
  hireProblem,
  hireRecordValues,
  initialHireDraft,
  targetDatabaseIds,
  WRITE_GATE_OPERATIONS,
} from './hire';
import type { HireContext, HireDraft, HireField, HireIO } from './hire';
import { HIRE_API_CAPABILITIES } from './hire-capabilities';
import type { Caps } from './hire-capabilities';
import { ACTIVE_WINDOW, everyOptions, offersWindow, scheduleTrigger } from './wake-rules';
import type { EveryKey, SchedRule, WakeRule } from './wake-rules';

/** Ticket #1196. Each test names the rule it holds: mutate the rule and the named test fails. */
const TZ = 'Europe/Madrid';
const FID = '22222222-2222-4222-8222-222222222222'; // the API takes uuids for a field
const OFF: Caps = { scheduleCadence: false, wholeSpaceTargets: false };

const FIELDS: HireField[] = [
  { apiName: 'name', type: 'title' },
  { apiName: 'ai_mode', type: 'select', options: [{ id: 'm-non', label: 'Non-AI' }, { id: 'm-own', label: 'Your own AI' }] },
  {
    apiName: 'approval_policy',
    type: 'multi_select',
    options: ['delete', 'webhook', 'email', 'run_button', 'outward'].map((label) => ({ id: `p-${label}`, label })),
  },
];

const ctx = (over: Partial<HireContext> = {}): HireContext => ({
  fields: FIELDS,
  agentsDatabaseId: 'AGENTS',
  role: 'admin',
  timeZone: TZ,
  databaseName: (id) => ({ d1: 'Clients', d2: 'Contacts' })[id] ?? 'record',
  fieldName: (_d, f) => (f === FID ? 'Status' : 'field'),
  ...over,
});

const sched = (over: Partial<SchedRule> = {}): SchedRule => ({ kind: 'sched', every: 'weekday', at: '09:00', weekday: 1, window: false, ...over });
const works = [
  { kind: 'db' as const, id: 'd1', name: 'Clients', spaceId: 's1' },
  { kind: 'db' as const, id: 'd2', name: 'Contacts', spaceId: 's1' },
];
const draft = (over: Partial<HireDraft> = {}): HireDraft => ({
  name: ' Client follow-up assistant ',
  job: 'Follow up',
  wakes: [sched()],
  works,
  asks: { ...DEFAULT_ASKS },
  runnerId: 'r1',
  ...over,
});

describe('the card opens with defaults a person edits (ticket #1196)', () => {
  it('an editable default name and job, the design’s default wake, empty Works in, every box ticked', () => {
    const d = initialHireDraft();
    expect(d.name).toBe(DEFAULT_AGENT_NAME);
    expect(d.name.trim().length).toBeGreaterThan(0);
    expect(d.job).toBe(DEFAULT_AGENT_JOB);
    expect(d.wakes).toEqual([{ kind: 'sched', every: 'weekday', at: '09:00', weekday: 1, window: false }]);
    expect(d.works).toEqual([]); // never an invented database
    expect(d.asks).toEqual({ email: true, outward: true, change: true, delete: true });
  });
  it('an edited name is what is hired (the default is not baked into the payload)', () => {
    const values = hireRecordValues({ ...initialHireDraft(), name: 'Sales assistant' }, ctx());
    expect(values?.name).toBe('Sales assistant');
  });
  it('without the 1194 API the default wake is "every day" (a weekday set does not exist yet)', () => {
    expect(initialHireDraft(OFF).wakes[0]).toMatchObject({ every: 'day' });
  });
});

describe('the record: name, job, AI mode, asks-before, works-in (AC2)', () => {
  it('exact payload with every box ticked: email, outward + webhook, delete are held; "change" is a gate, not a policy label', () => {
    expect(hireRecordValues(draft(), ctx())).toEqual({
      name: 'Client follow-up assistant',
      goal: [{ type: 'paragraph', content: [{ type: 'text', text: 'Follow up' }] }],
      ai_mode: 'm-own',
      approval_policy: ['p-email', 'p-outward', 'p-webhook', 'p-delete'],
      target_databases: 'd1, d2',
      enabled: true,
    });
  });
  it('unticking removes exactly that hold', () => {
    const v = hireRecordValues(draft({ asks: { ...DEFAULT_ASKS, email: false, delete: false } }), ctx());
    expect(v?.approval_policy).toEqual(['p-outward', 'p-webhook']);
    expect(hireRecordValues(draft({ asks: { email: false, outward: false, change: false, delete: false } }), ctx())).not.toHaveProperty('approval_policy');
  });
  it('no works-in leaves target_databases out; no job leaves goal out', () => {
    const v = hireRecordValues(draft({ works: [], job: '  ' }), ctx());
    expect(v).not.toHaveProperty('target_databases');
    expect(v).not.toHaveProperty('goal');
  });
  it('every approval-policy label a box can hold is one the API schema accepts', () => {
    for (const a of ASKS) for (const label of a.policy) expect(planAgentSchema.shape.approval_policy.safeParse([label]).success, label).toBe(true);
  });
  it('the fields not being loaded yields nothing to write, never a half record', () => {
    expect(hireRecordValues(draft(), ctx({ fields: [] }))).toBeNull();
  });
});

describe('every offered wake option is accepted by the API’s own schema (AC3)', () => {
  const EVERY_ALL: EveryKey[] = ['10min', '15min', '30min', 'hour', 'day', 'weekday', 'week'];
  it('each cadence the card offers, with and without the window, parses as an automation trigger with no problems', () => {
    for (const o of everyOptions()) {
      for (const window of [false, true]) {
        if (window && !offersWindow(o.value)) continue;
        const t = scheduleTrigger(sched({ every: o.value, window }), TZ);
        expect(automationTriggerSchema.safeParse(t).success, `${o.value} window=${window}: ${JSON.stringify(t)}`).toBe(true);
        expect(scheduleProblems(t as never), o.value).toEqual([]);
      }
    }
  });
  it('the options offered are exactly the seven designed ones while 1194 is on main', () => {
    expect(HIRE_API_CAPABILITIES.scheduleCadence).toBe(true);
    expect(everyOptions().map((o) => o.value)).toEqual(EVERY_ALL);
  });
  it('weekday is a day rule with Mon-Fri; week carries ONE weekday; the zone is always sent so 09:00 is never server time', () => {
    expect(scheduleTrigger(sched({ every: 'weekday', at: '09:00' }), TZ)).toEqual({ type: 'schedule', every: 'day', at: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: TZ });
    expect(scheduleTrigger(sched({ every: 'week', at: '08:30', weekday: 0 }), TZ)).toMatchObject({ every: 'week', weekday: 0, at: '08:30', timezone: TZ });
    expect(scheduleTrigger(sched({ every: '10min', window: true }), TZ)).toEqual({ type: 'schedule', every: 'minutes', minutes: 10, between: ACTIVE_WINDOW, timezone: TZ });
  });
  it('the window is only offered where the API takes one (minutes, hour), never on a day rule', () => {
    expect(offersWindow('hour')).toBe(true);
    expect(offersWindow('30min')).toBe(true);
    for (const e of ['day', 'weekday', 'week'] as const) expect(offersWindow(e), e).toBe(false);
    // a stale window flag on a day rule is not sent (the API would 422 it)
    const t = scheduleTrigger(sched({ every: 'day', window: true }), TZ);
    expect(t).not.toHaveProperty('between');
    expect(automationTriggerSchema.safeParse(t).success).toBe(true);
  });
  it('capability OFF (the API before 1194): only hour, day, week; no window; no minutes/weekdays/zone in the body, which still parses', () => {
    expect(everyOptions(OFF).map((o) => o.value)).toEqual(['hour', 'day', 'week']);
    for (const e of ['10min', 'hour', 'weekday'] as const) expect(offersWindow(e, OFF), e).toBe(false);
    for (const o of everyOptions(OFF)) {
      const t = scheduleTrigger(sched({ every: o.value, window: true }), TZ, OFF);
      expect(t).not.toHaveProperty('between');
      expect(t).not.toHaveProperty('timezone');
      expect(t).not.toHaveProperty('weekdays');
      expect(automationTriggerSchema.safeParse(t).success, o.value).toBe(true);
    }
  });
  it('a below-the-floor interval is never produced: the smallest offered is 10 minutes', () => {
    const mins = everyOptions().flatMap((o) => { const t = scheduleTrigger(sched({ every: o.value }), TZ) as { minutes?: number }; return t.minutes ? [t.minutes] : []; });
    expect(Math.min(...mins)).toBeGreaterThanOrEqual(10);
  });
  it('the write gate the card declares is one the API takes', () => {
    expect([...WRITE_GATE_OPERATIONS]).toEqual(['create', 'update']);
  });
});

describe('the calls after the record (AC2)', () => {
  const rules: WakeRule[] = [
    sched(),
    { kind: 'field', databaseId: 'd1', fieldId: FID },
    { kind: 'new', databaseId: 'd2' },
    { kind: 'assign', databaseId: 'd1', relationFieldId: 'rel1' },
  ];
  it('an admin’s card makes exactly: the gate, then each rule, then Runs on', () => {
    const calls = hireCalls(draft({ wakes: rules }), ctx(), 'AGENT');
    expect(calls.map((c) => c.kind)).toEqual(['gate', 'automation', 'automation', 'automation', 'binding', 'runner']);
    expect(calls[0]).toMatchObject({ body: { agent_id: 'AGENT', operations: ['create', 'update'] } });
    expect(calls[1]).toMatchObject({
      databaseId: 'd1', // a schedule lives on the first database it works in
      body: { trigger: { type: 'schedule', every: 'day', at: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: TZ }, actions: [{ type: 'run_agent', agent: 'AGENT' }] },
    });
    expect(calls[2]).toMatchObject({ databaseId: 'd1', body: { trigger: { type: 'record_updated', field_id: FID } } });
    expect(calls[3]).toMatchObject({ databaseId: 'd2', body: { trigger: { type: 'record_created' } } });
    expect(calls[4]).toMatchObject({ body: { agent: 'AGENT', database_id: 'd1', relation_field_id: 'rel1' } });
    expect(calls[5]).toMatchObject({ kind: 'runner', runnerId: 'r1' });
  });
  it('every automation body is a body the API’s createAutomationSchema accepts', () => {
    for (const c of hireCalls(draft({ wakes: rules }), ctx(), '11111111-1111-4111-8111-111111111111')) {
      if (c.kind !== 'automation') continue;
      const parsed = createAutomationSchema.safeParse(c.body);
      expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
      expect(c.body.name.length).toBeLessThanOrEqual(100);
    }
  });
  it('no Runner picked: no Runs on call (the agent waits; hiring is never blocked by it)', () => {
    expect(hireCalls(draft({ runnerId: null }), ctx(), 'A').some((c) => c.kind === 'runner')).toBe(false);
    expect(hireProblem(draft({ runnerId: null }), ctx())).toBeNull();
  });
  it('a MEMBER’s card never makes the two admin-only calls (the API refuses both)', () => {
    const calls = hireCalls(draft({ wakes: [sched(), { kind: 'assign', databaseId: 'd1', relationFieldId: 'rel1' }] }), ctx({ role: 'member' }), 'A');
    expect(calls.some((c) => c.kind === 'gate')).toBe(false);
    expect(canDeclareWriteGates('member')).toBe(false);
    expect(canBindAgentToAssignment('member')).toBe(false);
    expect(canDeclareWriteGates('admin')).toBe(true);
    expect(canDeclareWriteGates(undefined)).toBe(false); // role not loaded is "not yet", never allowed
    expect(hireProblem(draft({ wakes: [{ kind: 'assign', databaseId: 'd1', relationFieldId: 'rel1' }] }), ctx({ role: 'member' }))).toMatch(/admin/);
  });
  it('unticking "Changing a record" makes no gate', () => {
    expect(hireCalls(draft({ asks: { ...DEFAULT_ASKS, change: false } }), ctx(), 'A').some((c) => c.kind === 'gate')).toBe(false);
  });
  it('a guest is never offered Hire at all (named role predicate)', () => {
    expect(canHireAgents('guest')).toBe(false);
    expect(canHireAgents(undefined)).toBe(false);
    expect(canHireAgents('member')).toBe(true);
  });
});

describe('whole-space targets are not offered until the API has them (ticket #1195)', () => {
  it('a space chip cannot reach the payload while the capability is off', () => {
    expect(HIRE_API_CAPABILITIES.wholeSpaceTargets).toBe(false);
    expect(() => targetDatabaseIds([{ kind: 'space', id: 's1', name: 'Client Work' }])).toThrow(/whole-space target is not accepted/);
  });
  it('with the capability on, a space is accepted by the model (the payload shape is added with the API)', () => {
    expect(targetDatabaseIds([{ kind: 'space', id: 's1', name: 'Client Work' }, ...works], { scheduleCadence: true, wholeSpaceTargets: true })).toEqual(['d1', 'd2']);
  });
});

describe('Hire is blocked only by something the person can fix, and says what', () => {
  it('a name is required', () => expect(hireProblem(draft({ name: '  ' }), ctx())).toBe('Give it a name.'));
  it('a schedule never forces a database: with no Works in it lives on the Agents database, with one it lives there', () => {
    expect(hireProblem(draft({ works: [] }), ctx())).toBeNull();
    expect(hireProblem(draft(), ctx())).toBeNull();
    const home = (w: HireDraft['works']) => hireCalls(draft({ works: w }), ctx(), 'A').find((c) => c.kind === 'automation');
    expect(home([])).toMatchObject({ databaseId: 'AGENTS' });
    expect(home(works)).toMatchObject({ databaseId: 'd1' });
  });
  it('"Unconfigured is not invalid" does not mean dropped: a half-made field rule blocks the hire and names it', () => {
    expect(hireProblem(draft({ wakes: [{ kind: 'field', databaseId: 'd1', fieldId: null }] }), ctx())).toMatch(/which field/);
  });
  it('a rule on a database that is no longer in Works in blocks the hire', () => {
    expect(hireProblem(draft({ wakes: [{ kind: 'new', databaseId: 'gone' }] }), ctx())).toMatch(/Works in/);
  });
  it('an Agents database with no option for a ticked hold switches Hire off instead of hiring an agent that asks less', () => {
    const fields = FIELDS.map((f) => (f.apiName === 'approval_policy' ? { ...f, options: f.options!.filter((o) => o.label !== 'outward') } : f));
    expect(hireProblem(draft(), ctx({ fields }))).toMatch(/outward/);
  });
});

describe('a hire is never a SILENT partial hire (AC2)', () => {
  const io = (over: Partial<HireIO> = {}): HireIO & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      createAgent: async () => { calls.push('agent'); return { id: 'A1' }; },
      createGate: async () => { calls.push('gate'); },
      createAutomation: async () => { calls.push('automation'); },
      createBinding: async () => { calls.push('binding'); },
      assignRunner: async () => { calls.push('runner'); },
      describe: (e) => (e instanceof Error ? e.message : String(e)),
      ...over,
    };
  };
  it('everything applies: no failures, in order', async () => {
    const i = io();
    const out = await executeHire(draft(), ctx(), i);
    expect(out).toEqual({ agentId: 'A1', failed: [] });
    expect(i.calls).toEqual(['agent', 'gate', 'automation', 'runner']);
    expect(hireOutcomeMessage('Sales assistant', out)).toBe('Sales assistant is hired.');
  });
  it('a failing follow-up does not stop the rest, and is named with the API’s reason', async () => {
    const i = io({ createAutomation: async () => { throw new Error('You need Creator access to Clients.'); } });
    const out = await executeHire(draft(), ctx(), i);
    expect(i.calls).toEqual(['agent', 'gate', 'runner']); // the Runner still got assigned
    expect(out.agentId).toBe('A1');
    expect(out.failed).toEqual([{ what: 'Wakes when: every weekday at 09:00', reason: 'You need Creator access to Clients.' }]);
    expect(hireOutcomeMessage('Sales assistant', out)).toBe(
      'Sales assistant is hired, but 1 setting did not apply: Wakes when: every weekday at 09:00 (You need Creator access to Clients). Everything else was saved. Set it on its page.',
    );
  });
  it('several failures are all listed', async () => {
    const i = io({ createGate: async () => { throw new Error('Only an admin can.'); }, assignRunner: async () => { throw new Error('That Runner is gone.'); } });
    const out = await executeHire(draft(), ctx(), i);
    expect(out.failed.map((f) => f.what)).toEqual(['Asking before changing a record', 'Runs on']);
    expect(hireOutcomeMessage('X', out)).toContain('2 settings did not apply');
  });
  it('if the record itself is refused, nothing else is attempted and nothing exists', async () => {
    const i = io({ createAgent: async () => { throw new Error('Name already in use'); } });
    await expect(executeHire(draft(), ctx(), i)).rejects.toThrow('Name already in use');
    expect(i.calls).toEqual([]);
  });
  it('fields not loaded: refuses before any call', async () => {
    const i = io();
    await expect(executeHire(draft(), ctx({ fields: [] }), i)).rejects.toThrow(/still loading/);
    expect(i.calls).toEqual([]);
  });
});
