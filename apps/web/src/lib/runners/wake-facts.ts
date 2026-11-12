import { databaseNoun } from '@/lib/records';
import type { TriggerBindingLike } from './catch-up';

/**
 * Ticket #1289 — the agent page's "Wakes when" and "Works in" facts, as pure words. Nothing here fetches: the page hands in the
 * Agent Triggers records, a lookup for each trigger database, and the `agents/{agent}/scope` answer, and this file says what a
 * person reads. Each rule below has a test that fails when it is broken.
 *
 * WHAT IS AND IS NOT KNOWN. Only the agent's own triggers (state, assignment) are readable in one place. Schedules, "a field
 * changes" and "a new record" are automations on a database, with a `run_agent` action, and no workspace-level list of them
 * exists yet, so this file never claims the agent has no other way to wake: the page says wake rules are set per database, in
 * Automations. A trigger that is switched Off is shown as Off, never left out (a pack's switchable triggers install Off).
 * A reference to something deleted reads "deleted"; an id is never shown.
 */

export interface DbWords {
  name?: string | null;
  fields?: ReadonlyArray<{ id: string; displayName?: string; options?: ReadonlyArray<{ id: string; label: string }> }>;
}

/** What the page learned about a trigger's database: its detail, or that it is gone. */
export type DbLookup = { kind: 'ok'; db: DbWords } | { kind: 'deleted' };

export type WakeLineState = 'on' | 'off';

export interface WakeLine {
  key: string;
  /** What wakes the agent, in words. */
  text: string;
  state: WakeLineState;
  /** A human-gated trigger never starts a run by itself: a person starts each one. */
  gated: boolean;
  /** The trigger's database, when it still exists (the link target). */
  databaseId: string | null;
}

/** "A client" / "An issue": the article follows the noun's first sound (vowel letters; good enough for database names). */
const article = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'An' : 'A');

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function belongsTo(b: TriggerBindingLike, agentId: string): boolean {
  const ref = b.values['agent'];
  return Array.isArray(ref) && (ref[0] as { id?: string } | undefined)?.id === agentId;
}

/** The ids of the databases this agent's triggers watch (distinct, in record order): what the page must look up. */
export function triggerDatabaseIds(bindings: readonly TriggerBindingLike[], agentId: string): string[] {
  const out: string[] = [];
  for (const b of bindings) {
    const id = belongsTo(b, agentId) ? asString(b.values['database']) : null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * One line per trigger of this agent. "A client’s Status becomes Onboarding" for a state trigger, "A client is assigned to it" for
 * an assignment one; a field, option or database that no longer exists says so instead of guessing.
 */
export function wakeLines(bindings: readonly TriggerBindingLike[], agentId: string, lookup: (databaseId: string) => DbLookup | undefined): WakeLine[] {
  const lines: WakeLine[] = [];
  bindings.forEach((b, i) => {
    if (!belongsTo(b, agentId)) return;
    const v = b.values;
    const databaseId = asString(v['database']);
    const state: WakeLineState = v['enabled'] === true ? 'on' : 'off';
    const gated = v['human_gate'] === true;
    const key = `${databaseId ?? 'none'}-${i}`;
    const found = databaseId ? lookup(databaseId) : undefined;
    if (!databaseId || found?.kind === 'deleted') {
      lines.push({ key, text: 'A trigger on a database that was deleted', state, gated, databaseId: null });
      return;
    }
    if (!found) {
      // Still loading, or unreadable: say less rather than guess a noun.
      lines.push({ key, text: 'A trigger on one of its databases', state, gated, databaseId });
      return;
    }
    const noun = databaseNoun(found.db.name);
    const relationFieldId = asString(v['relation_field']);
    if (relationFieldId) {
      const exists = found.db.fields?.some((f) => f.id === relationFieldId);
      lines.push({ key, text: exists ? `${article(noun)} ${noun} is assigned to it` : `${article(noun)} ${noun} is assigned to it (field deleted)`, state, gated, databaseId });
      return;
    }
    const fieldId = asString(v['state_field']);
    const optionId = asString(v['state_option']);
    const field = fieldId ? found.db.fields?.find((f) => f.id === fieldId) : undefined;
    const option = optionId ? field?.options?.find((o) => o.id === optionId) : undefined;
    lines.push({
      key,
      text: field?.displayName && option ? `${article(noun)} ${noun}’s ${field.displayName} becomes ${option.label}` : `${article(noun)} ${noun}’s trigger state (field or option deleted)`,
      state,
      gated,
      databaseId,
    });
  });
  return lines;
}

/** The chip after a line: Off beats gated (an Off trigger starts nothing at all). */
export function wakeChip(line: Pick<WakeLine, 'state' | 'gated'>): string | null {
  if (line.state === 'off') return 'Off';
  return line.gated ? 'Starts only when you do' : null;
}

/** The sentence under the lines. Wake rules that are automations cannot be listed yet, so it never says "nothing else wakes it". */
export const WAKE_RULES_NOTE = { before: 'Wake rules are set per database, in ', link: 'Automations', after: '.' } as const;

/** What a person reads when the agent has no trigger of its own. Not "nothing wakes it": automations are not listed here. */
export const NO_TRIGGER_LINE = 'No trigger of its own.';

// ---------- Works in ----------

/** The part of `GET /workspaces/{ws}/agents/{agent}/scope` this file reads (the SDK types its response as empty). */
export interface AgentScopeDto {
  enforced?: boolean;
  spaces?: ReadonlyArray<{ id: string; name: string }>;
  databases?: ReadonlyArray<{ id: string; name: string; space_id: string; via?: 'database' | 'space' }>;
  unresolved?: readonly string[];
  withheld_count?: number;
}

export interface WorksInSpace {
  id: string;
  name: string;
  /** The databases the server resolved in it, now. A database added to the space later is included on the next read. */
  databases: string[];
}

export interface WorksInFact {
  spaces: WorksInSpace[];
  /** Databases named directly (not inside a targeted space), as `{id, name}` so each can link. */
  databases: Array<{ id: string; name: string }>;
  /** Entries that matched nothing (deleted, or a personal space). Counted, never named: they hold raw ids. */
  unresolved: number;
  /** Candidates the manager's own access removed. */
  withheld: number;
}

export function worksInFact(scope: AgentScopeDto): WorksInFact {
  const spaces = scope.spaces ?? [];
  const dbs = scope.databases ?? [];
  const inSpace = new Set(spaces.map((s) => s.id));
  return {
    spaces: spaces.map((s) => ({ id: s.id, name: s.name, databases: dbs.filter((d) => d.space_id === s.id).map((d) => d.name) })),
    databases: dbs.filter((d) => !inSpace.has(d.space_id)).map((d) => ({ id: d.id, name: d.name })),
    unresolved: scope.unresolved?.length ?? 0,
    withheld: typeof scope.withheld_count === 'number' && scope.withheld_count > 0 ? scope.withheld_count : 0,
  };
}

export function isEmptyWorksIn(f: WorksInFact): boolean {
  return f.spaces.length === 0 && f.databases.length === 0 && f.unresolved === 0 && f.withheld === 0;
}

/** "4 databases now: Clients, Contacts. Databases added to Client Work later are included." (the prototype's sentence). */
export function spaceNote(s: WorksInSpace): string {
  const n = s.databases.length;
  const now = n === 0 ? 'No databases in it yet' : `${n} ${n === 1 ? 'database' : 'databases'} now: ${s.databases.join(', ')}`;
  return `${now}. Databases added to ${s.name} later are included.`;
}

export function unresolvedLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 target no longer exists or is private.' : `${n} targets no longer exist or are private.`;
}

export function withheldLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 more is not open to its manager, so it cannot reach it.' : `${n} more are not open to its manager, so it cannot reach them.`;
}

/** Only a workspace admin may read either fact: the agents controller is admin-only. A member who manages the agent never sees the rows. */
export function canReadWakeFacts(role: string | undefined): boolean {
  return role === 'admin';
}
