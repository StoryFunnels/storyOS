import type { FieldWithOptions } from './agents';
import { apiAccepts } from './hire-capabilities';
import type { Caps } from './hire-capabilities';
import { canBindAgentToAssignment, canDeclareWriteGates } from './access';
import { defaultSchedule, describeSchedule, scheduleRuleProblems, scheduleTrigger, singular } from './wake-rules';
import type { WakeRule } from './wake-rules';

/**
 * Ticket #1139 AC3 + ticket #1196 — hiring an agent from the web.
 *
 * There is no server "hire" endpoint (ADR-0021 §11 question 13, ruled: confirmed), so hiring is a RECORD in the Agents database
 * plus a few follow-up calls on the endpoints that already exist. This file is the whole mapping, pure, so a test can say exactly
 * which calls a card produces:
 *
 *   name, job, AI mode, enabled, "Asks before" (approval policy), works in   -> ONE record (POST .../databases/{agents}/records)
 *   "Changing a record" held                                                  -> POST /workspaces/{ws}/agent-write-gates   (admin)
 *   each wake rule                                                            -> an automation (run_agent) or an agent trigger
 *   Runs on                                                                   -> PUT  /workspaces/{ws}/runner-assignments/{agent}
 *
 * An agent hired here is "Your own AI" and enabled: that is the mode a Runner serves. It is hired whether or not any Runner
 * exists (`hireState`, `runs-on.ts`): the agent just waits for one.
 *
 * ATOMIC FROM THE PERSON'S VIEW: the record is the one call that can fail with nothing created. Every call after it can fail on its
 * own, and a half-set-up agent is worse than a refused hire only when nobody says so; `executeHire` therefore returns EXACTLY
 * which settings did not apply, and the card says them. Nothing is dropped silently.
 */
export interface HireInput {
  name: string;
  goal: string;
  /** Approval-policy OPTION IDS to hold (the API refuses labels on a select). Omitted/empty: none held. */
  policy?: readonly string[];
  /** Database ids the agent works in (`target_databases`, one comma-separated text field). Omitted/empty: not set. */
  targetDatabaseIds?: readonly string[];
  /** Space ids the agent works in WHOLE (`target_spaces`, ticket #1195): resolved to the space's databases when the agent acts, never expanded here. */
  targetSpaceIds?: readonly string[];
}

export interface HireFields {
  titleApiName: string;
  values: Record<string, unknown>;
}

export interface HireField extends FieldWithOptions {
  type?: string;
}

/** The record body for `POST .../databases/{agents}/records`, or null when the database's fields are not known yet. */
export function buildHireValues(input: HireInput, fields: readonly HireField[]): Record<string, unknown> | null {
  const title = fields.find((f) => f.type === 'title');
  const aiMode = fields.find((f) => f.apiName === 'ai_mode');
  const own = aiMode?.options?.find((o) => o.label === 'Your own AI');
  if (!title || !own) return null;
  const goal = input.goal.trim();
  const policy = input.policy ?? [];
  const targets = input.targetDatabaseIds ?? [];
  const spaceTargets = input.targetSpaceIds ?? [];
  return {
    [title.apiName]: input.name.trim(),
    ...(goal ? { goal: [{ type: 'paragraph', content: [{ type: 'text', text: goal }] }] } : {}),
    ai_mode: own.id,
    ...(policy.length ? { approval_policy: [...policy] } : {}),
    ...(targets.length ? { target_databases: targets.join(', ') } : {}),
    ...(spaceTargets.length ? { target_spaces: spaceTargets.join(', ') } : {}),
    enabled: true,
  };
}

/** The Hire button's rule for the name alone: see `hireProblem` for the whole card. Not a Runner: see `hireState`. */
export function canSubmitHire(name: string, busy: boolean): boolean {
  return name.trim().length > 0 && !busy;
}

// ---------- "Asks before" ----------

export type AskKey = 'email' | 'outward' | 'change' | 'delete';

/**
 * The four checkboxes and what each holds. `policy` is the labels of the agent record's "Approval policy" multi-select
 * (`APPROVAL_POLICY_KINDS`, ADR-0010 §4). "Anything that leaves the workspace" holds `outward` AND `webhook` (calling another
 * service leaves the workspace too: leaving it out would make a ticked box hold less than it says). "Changing a record" is not an
 * approval-policy label at all: it is a write gate on the agent (ticket #1104), declared with its own call.
 */
export const ASKS: ReadonlyArray<{ key: AskKey; label: string; policy: readonly string[]; gate?: boolean }> = [
  { key: 'email', label: 'Sending an email', policy: ['email'] },
  { key: 'outward', label: 'Anything that leaves the workspace', policy: ['outward', 'webhook'] },
  { key: 'change', label: 'Changing a record', policy: [], gate: true },
  { key: 'delete', label: 'Deleting anything', policy: ['delete'] },
];

/** All ticked: an agent starts safe and a person unticks to trust it (Dara, ticket #1191). */
export const DEFAULT_ASKS: Readonly<Record<AskKey, boolean>> = { email: true, outward: true, change: true, delete: true };

/** The gate "Changing a record" declares: holds a create or an update, on any database. The API's own shape (`agent-write-gates.controller.ts`). */
export const WRITE_GATE_OPERATIONS = ['create', 'update'] as const;

// ---------- Works in ----------

export type WorkTarget = { kind: 'db'; id: string; name: string; spaceId: string } | { kind: 'space'; id: string; name: string };

/** The databases `target_databases` carries. A space target is only possible once the API has one (ticket #1195): until then it is a bug to hold one. */
export function targetDatabaseIds(works: readonly WorkTarget[], caps?: Caps): string[] {
  if (works.some((w) => w.kind === 'space') && !apiAccepts('wholeSpaceTargets', caps)) {
    throw new Error('A whole-space target is not accepted by the API yet');
  }
  return [...new Set(works.filter((w): w is Extract<WorkTarget, { kind: 'db' }> => w.kind === 'db').map((w) => w.id))];
}

/** The spaces `target_spaces` carries (whole spaces only; their databases are resolved by the API each time the agent acts). */
export function targetSpaceIds(works: readonly WorkTarget[], caps?: Caps): string[] {
  const ids = [...new Set(works.filter((w): w is Extract<WorkTarget, { kind: 'space' }> => w.kind === 'space').map((w) => w.id))];
  if (ids.length > 0 && !apiAccepts('wholeSpaceTargets', caps)) throw new Error('A whole-space target is not accepted by the API yet');
  return ids;
}

/** Whether the Agents database already has the `target_spaces` field (an older one gets it from `POST /agents/ensure`). */
export function holdsSpaceTargets(fields: readonly { apiName?: string }[]): boolean {
  return fields.some((f) => f.apiName === 'target_spaces');
}

// ---------- The card ----------

export interface HireDraft {
  name: string;
  job: string;
  wakes: WakeRule[];
  works: WorkTarget[];
  asks: Record<AskKey, boolean>;
  /** The Runner picked on the card; null = none (the agent waits for one). */
  runnerId: string | null;
}

/** The design's own example (prototype v60): a default the person edits in place, never a blank to fill. */
export const DEFAULT_AGENT_NAME = 'Client follow-up assistant';
export const DEFAULT_AGENT_JOB = 'Follow up on clients that went quiet and draft the next email for me';

/** What the card opens with: an editable name and job, "Every weekday at 9:00", nothing in Works in (never an invented database), every box ticked. */
export function initialHireDraft(caps?: Caps): HireDraft {
  return { name: DEFAULT_AGENT_NAME, job: DEFAULT_AGENT_JOB, wakes: [defaultSchedule(caps)], works: [], asks: { ...DEFAULT_ASKS }, runnerId: null };
}

export interface HireContext {
  fields: readonly HireField[];
  /** The Agents database: the home of a schedule rule when the agent works in no database yet. */
  agentsDatabaseId: string;
  role: string | undefined;
  timeZone: string;
  caps?: Caps;
  /** Ids of the databases a whole-space chip covers today: a wake rule may watch any of them (they are in "Works in" too). */
  spaceDatabaseIds?: readonly string[];
  /** Names for the rules' automation titles and the failure sentences. */
  databaseName: (id: string) => string;
  fieldName: (databaseId: string, fieldId: string) => string;
}

function selectedLabels(draft: HireDraft): string[] {
  return ASKS.filter((a) => draft.asks[a.key]).flatMap((a) => [...a.policy]);
}

/** Labels of the approval policy the Agents database has no option for (an older database): said, never dropped. */
export function missingPolicyLabels(draft: HireDraft, fields: readonly HireField[]): string[] {
  const options = fields.find((f) => f.apiName === 'approval_policy')?.options ?? [];
  return selectedLabels(draft).filter((l) => !options.some((o) => o.label === l));
}

function policyIds(draft: HireDraft, fields: readonly HireField[]): string[] {
  const options = fields.find((f) => f.apiName === 'approval_policy')?.options ?? [];
  return selectedLabels(draft)
    .map((l) => options.find((o) => o.label === l)?.id)
    .filter((id): id is string => Boolean(id));
}

/** The record the card creates, or null while the Agents database's fields are not known. */
export function hireRecordValues(draft: HireDraft, ctx: Pick<HireContext, 'fields' | 'caps'>): Record<string, unknown> | null {
  return buildHireValues(
    {
      name: draft.name,
      goal: draft.job,
      policy: policyIds(draft, ctx.fields),
      targetDatabaseIds: targetDatabaseIds(draft.works, ctx.caps),
      targetSpaceIds: targetSpaceIds(draft.works, ctx.caps),
    },
    ctx.fields,
  );
}

/**
 * The database a schedule rule lives on. A schedule runs with no record, but an automation belongs to a database: the first one the
 * agent works in, or, when it works in none yet, the Agents database itself (verified: the API accepts a schedule rule there, for a
 * member as well as an admin). So a schedule never forces a person to pick a database just to hire.
 */
export function homeDatabaseId(works: readonly WorkTarget[], agentsDatabaseId: string): string {
  return works.find((w): w is Extract<WorkTarget, { kind: 'db' }> => w.kind === 'db')?.id ?? agentsDatabaseId;
}

/**
 * Why Hire cannot be pressed yet, in a sentence a person can act on; null when it can. Never a missing Runner (hiring is never
 * blocked by one). "Unconfigured is not invalid": a half-made wake rule blocks the hire and says which, it is not quietly dropped.
 */
export function hireProblem(draft: HireDraft, ctx: HireContext): string | null {
  if (!draft.name.trim()) return 'Give it a name.';
  const dbIds = new Set([...draft.works.filter((w) => w.kind === 'db').map((w) => w.id), ...(ctx.spaceDatabaseIds ?? [])]);
  const missing = missingPolicyLabels(draft, ctx.fields);
  if (missing.length) return `This workspace’s Agents database cannot hold “${missing.join(', ')}” yet, so Hire is switched off rather than hiring an agent that asks less than the boxes say.`;
  for (const r of draft.wakes) {
    if (r.kind === 'sched') {
      const p = scheduleRuleProblems(r, ctx.timeZone, ctx.caps)[0];
      if (p) return p;
    } else {
      if (!r.databaseId || !dbIds.has(r.databaseId)) return 'Choose which database each wake rule watches (it must be one of Works in).';
      if (r.kind === 'field' && !r.fieldId) return 'Choose which field “When a field changes” watches.';
      if (r.kind === 'assign') {
        if (!r.relationFieldId) return 'Choose the database where you assign it a record.';
        if (!canBindAgentToAssignment(ctx.role)) return 'Only a workspace admin can wake an agent by assigning it a record.';
      }
    }
  }
  return null;
}

// ---------- The calls ----------

export type HireCall =
  | { kind: 'gate'; what: string; body: { agent_id: string; operations: Array<'create' | 'update'> } }
  | { kind: 'automation'; what: string; databaseId: string; body: { name: string; trigger: Record<string, unknown>; actions: Array<Record<string, unknown>>; enabled: true } }
  | { kind: 'binding'; what: string; body: { agent: string; database_id: string; relation_field_id: string } }
  | { kind: 'runner'; what: string; runnerId: string };

function ruleName(agentName: string, text: string): string {
  const full = `${agentName.trim()}: ${text}`;
  return full.length > 100 ? `${full.slice(0, 99)}…` : full;
}

/** Every call after the record, for the agent just created. A call that is not allowed for this role is not offered on the card, so it is not made here. */
export function hireCalls(draft: HireDraft, ctx: HireContext, agentId: string): HireCall[] {
  const calls: HireCall[] = [];
  if (draft.asks.change && canDeclareWriteGates(ctx.role)) {
    calls.push({ kind: 'gate', what: 'Asking before changing a record', body: { agent_id: agentId, operations: [...WRITE_GATE_OPERATIONS] } });
  }
  const runAgent = { type: 'run_agent', agent: agentId };
  for (const r of draft.wakes) {
    if (r.kind === 'sched') {
      const databaseId = homeDatabaseId(draft.works, ctx.agentsDatabaseId);
      const text = describeSchedule(r);
      calls.push({
        kind: 'automation',
        what: `Wakes when: ${text.charAt(0).toLowerCase()}${text.slice(1)}`,
        databaseId,
        body: { name: ruleName(draft.name, text), trigger: scheduleTrigger(r, ctx.timeZone, ctx.caps) as unknown as Record<string, unknown>, actions: [runAgent], enabled: true },
      });
    } else if (r.kind === 'field' && r.databaseId && r.fieldId) {
      const text = `${singular(ctx.databaseName(r.databaseId))}’s ${ctx.fieldName(r.databaseId, r.fieldId)} changes`;
      calls.push({
        kind: 'automation',
        what: `Wakes when: a ${text}`,
        databaseId: r.databaseId,
        body: { name: ruleName(draft.name, `wakes when ${text}`), trigger: { type: 'record_updated', field_id: r.fieldId }, actions: [runAgent], enabled: true },
      });
    } else if (r.kind === 'new' && r.databaseId) {
      const text = `a new ${singular(ctx.databaseName(r.databaseId))} is added`;
      calls.push({
        kind: 'automation',
        what: `Wakes when: ${text}`,
        databaseId: r.databaseId,
        body: { name: ruleName(draft.name, `wakes when ${text}`), trigger: { type: 'record_created' }, actions: [runAgent], enabled: true },
      });
    } else if (r.kind === 'assign' && r.databaseId && r.relationFieldId) {
      calls.push({
        kind: 'binding',
        what: `Wakes when: you assign it a ${singular(ctx.databaseName(r.databaseId))}`,
        body: { agent: agentId, database_id: r.databaseId, relation_field_id: r.relationFieldId },
      });
    }
  }
  if (draft.runnerId) calls.push({ kind: 'runner', what: 'Runs on', runnerId: draft.runnerId });
  return calls;
}

export interface HireIO {
  createAgent: (values: Record<string, unknown>) => Promise<{ id: string }>;
  createGate: (body: Extract<HireCall, { kind: 'gate' }>['body']) => Promise<unknown>;
  createAutomation: (databaseId: string, body: Extract<HireCall, { kind: 'automation' }>['body']) => Promise<unknown>;
  createBinding: (body: Extract<HireCall, { kind: 'binding' }>['body']) => Promise<unknown>;
  assignRunner: (agentId: string, runnerId: string) => Promise<unknown>;
  /** The API's own sentence for a refusal. */
  describe: (error: unknown) => string;
}

export interface HireOutcome {
  agentId: string;
  /** Every follow-up that did not apply, with the reason. Empty = everything applied. */
  failed: Array<{ what: string; reason: string }>;
}

/**
 * Creates the agent, then each follow-up, in order. If the record is refused this THROWS and nothing exists. Once it exists, a
 * failing follow-up never stops the rest: it is recorded, and the card tells the person which settings did not apply.
 */
export async function executeHire(draft: HireDraft, ctx: HireContext, io: HireIO): Promise<HireOutcome> {
  const values = hireRecordValues(draft, ctx);
  if (!values) throw new Error('The Agents database is still loading. Try again in a moment.');
  const agent = await io.createAgent(values);
  const failed: HireOutcome['failed'] = [];
  for (const call of hireCalls(draft, ctx, agent.id)) {
    try {
      if (call.kind === 'gate') await io.createGate(call.body);
      else if (call.kind === 'automation') await io.createAutomation(call.databaseId, call.body);
      else if (call.kind === 'binding') await io.createBinding(call.body);
      else await io.assignRunner(agent.id, call.runnerId);
    } catch (e) {
      failed.push({ what: call.what, reason: io.describe(e) });
    }
  }
  return { agentId: agent.id, failed };
}

/** What the toast says. Names every setting that did not apply and says everything else was saved. */
export function hireOutcomeMessage(name: string, outcome: HireOutcome): string {
  const n = name.trim();
  if (outcome.failed.length === 0) return `${n} is hired.`;
  const list = outcome.failed.map((f) => `${f.what} (${f.reason.replace(/[.\s]+$/, '')})`).join('; ');
  const count = outcome.failed.length === 1 ? '1 setting' : `${outcome.failed.length} settings`;
  return `${n} is hired, but ${count} did not apply: ${list}. Everything else was saved. Set ${outcome.failed.length === 1 ? 'it' : 'them'} on its page.`;
}
