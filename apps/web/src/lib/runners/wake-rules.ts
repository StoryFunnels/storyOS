import { scheduleRunsPerDay, scheduleProblems } from '@storyos/schemas';
import type { ScheduleTrigger } from '@storyos/schemas';
import { apiAccepts } from './hire-capabilities';
import type { Caps } from './hire-capabilities';

/**
 * Ticket #1196 — the hire card's "Wakes when" list as a model. A rule is what a person sees ("Every weekday at 09:00"); this file
 * turns each into the one API call that makes it real, and says how often it will run. Every offered option is checked against
 * the API's own zod schema in the tests, so an option the API refuses cannot be added without a test failing.
 *
 * Where each rule lives (read from the controllers, not guessed):
 *  - a schedule, "when a field changes" and "when a new record is added" are AUTOMATIONS on a database with a `run_agent` action
 *    (POST /workspaces/{ws}/databases/{db}/automations): a schedule runs with no record, so it needs a database to live on.
 *  - "when you assign it a record" is an AGENT TRIGGER of the relation kind (POST /workspaces/{ws}/agents/triggers): a relation
 *    field on a database that points at the Agents database. Admin only on the API.
 */

export type EveryKey = '10min' | '15min' | '30min' | 'hour' | 'day' | 'weekday' | 'week';

export const EVERY_LABELS: ReadonlyArray<{ value: EveryKey; label: string }> = [
  { value: '10min', label: '10 minutes' },
  { value: '15min', label: '15 minutes' },
  { value: '30min', label: '30 minutes' },
  { value: 'hour', label: 'hour' },
  { value: 'day', label: 'day' },
  { value: 'weekday', label: 'weekday (Mon–Fri)' },
  { value: 'week', label: 'week' },
];

/** The cadences the API accepts today. Before ticket #1194 only hour / day / week existed (and one weekday per rule). */
export function everyOptions(caps?: Caps): ReadonlyArray<{ value: EveryKey; label: string }> {
  return apiAccepts('scheduleCadence', caps) ? EVERY_LABELS : EVERY_LABELS.filter((o) => o.value === 'hour' || o.value === 'day' || o.value === 'week');
}

function isMinutes(every: EveryKey): boolean {
  return every === '10min' || every === '15min' || every === '30min';
}

/** Whether the "only 9:00–18:00" window is offered for this cadence (the API takes a window on minutes and hour only). */
export function offersWindow(every: EveryKey, caps?: Caps): boolean {
  return apiAccepts('scheduleCadence', caps) && (isMinutes(every) || every === 'hour');
}

/** Whether the cadence has a time of day ("at 09:00"). */
export function hasTimeOfDay(every: EveryKey): boolean {
  return every === 'day' || every === 'weekday' || every === 'week';
}

/** 00:00 … 23:30 in 30-minute steps: the list the time menu offers (a native time input was ruled "bad design"). */
export const TIME_STEPS: readonly string[] = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

/** Monday first, as the design lists them. `value` is the API's weekday: 0 = Sunday … 6 = Saturday. */
export const WEEKDAY_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

/** The window the checkbox means. Fixed on purpose: the design offers one ("only 9:00–18:00"), not a pair of pickers. */
export const ACTIVE_WINDOW = { from: '09:00', to: '18:00' } as const;

export interface SchedRule {
  kind: 'sched';
  every: EveryKey;
  at: string;
  weekday: number;
  window: boolean;
}
export interface FieldRule {
  kind: 'field';
  databaseId: string | null;
  fieldId: string | null;
}
export interface NewRule {
  kind: 'new';
  databaseId: string | null;
}
export interface AssignRule {
  kind: 'assign';
  databaseId: string | null;
  /** The relation field on that database that points at the Agents database. */
  relationFieldId: string | null;
}
export type WakeRule = SchedRule | FieldRule | NewRule | AssignRule;
export type WakeRuleKind = WakeRule['kind'];

interface FieldLike {
  id: string;
  type: string;
  displayName: string;
  isSystem?: boolean;
  deprecated?: boolean;
  relation?: { target_database_id: string };
}

/** The fields "When a field changes" may watch: ones a person edits. A derived field (formula, rollup, lookup, ai) or a relation (a link is its own event) never "changes" by an edit. */
export function isWatchableField(f: Pick<FieldLike, 'type' | 'isSystem' | 'deprecated'>): boolean {
  return !f.isSystem && !f.deprecated && !['relation', 'lookup', 'rollup', 'formula', 'button', 'ai'].includes(f.type);
}

/** The relation field on a database that points at the Agents database: the one "When you assign it a record" binds to. Null when it has none. */
export function agentRelationField<T extends FieldLike>(fields: readonly T[] | undefined, agentsDatabaseId: string): T | null {
  return fields?.find((f) => f.type === 'relation' && f.relation?.target_database_id === agentsDatabaseId) ?? null;
}

/** "Clients" -> "Client", for "When a new Client is added". Conservative: "Business", "Status" and a name that does not end in s are left alone. */
export function singular(name: string): string {
  const n = name.trim();
  if (/ies$/i.test(n)) return `${n.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(n) || !/s$/i.test(n)) return n;
  return n.slice(0, -1);
}

/** "Every weekday at 9:00": the design's own default, expressible since ticket #1194. Before it, the default is "every day". */
export function defaultSchedule(caps?: Caps): SchedRule {
  return { kind: 'sched', every: apiAccepts('scheduleCadence', caps) ? 'weekday' : 'day', at: '09:00', weekday: 1, window: false };
}

export function newRule(kind: WakeRuleKind, o: { databaseId: string | null; relationFieldId?: string | null }, caps?: Caps): WakeRule {
  if (kind === 'sched') return { ...defaultSchedule(caps), every: 'hour' };
  if (kind === 'field') return { kind, databaseId: o.databaseId, fieldId: null };
  if (kind === 'new') return { kind, databaseId: o.databaseId };
  return { kind, databaseId: o.databaseId, relationFieldId: o.relationFieldId ?? null };
}

/**
 * "Works in" changed: every rule that watches a database must still point at one the agent works in. A field/new rule whose
 * database went away moves to the first remaining one (its field choice is cleared: a field belongs to its database) or, with none
 * left, to nothing, which the card then says out loud; an assign rule on a database that went away is removed (it has no other
 * meaning). A schedule has no database of its own.
 */
export function rebaseRules(rules: readonly WakeRule[], dbIds: readonly string[]): WakeRule[] {
  const out: WakeRule[] = [];
  for (const r of rules) {
    if (r.kind === 'sched' || (r.databaseId && dbIds.includes(r.databaseId))) out.push(r);
    else if (r.kind === 'assign') continue;
    else out.push(r.kind === 'field' ? { ...r, databaseId: dbIds[0] ?? null, fieldId: null } : { ...r, databaseId: dbIds[0] ?? null });
  }
  return out;
}

/** The schedule trigger the API takes for this rule. `timeZone` is the zone the times were read in: "09:00" must never become server time. */
export function scheduleTrigger(rule: SchedRule, timeZone: string, caps?: Caps): ScheduleTrigger {
  let t: ScheduleTrigger;
  switch (rule.every) {
    case '10min':
      t = { type: 'schedule', every: 'minutes', minutes: 10 };
      break;
    case '15min':
      t = { type: 'schedule', every: 'minutes', minutes: 15 };
      break;
    case '30min':
      t = { type: 'schedule', every: 'minutes', minutes: 30 };
      break;
    case 'hour':
      t = { type: 'schedule', every: 'hour' };
      break;
    case 'day':
      t = { type: 'schedule', every: 'day', at: rule.at };
      break;
    case 'weekday':
      t = { type: 'schedule', every: 'day', at: rule.at, weekdays: [1, 2, 3, 4, 5] };
      break;
    case 'week':
      t = { type: 'schedule', every: 'week', at: rule.at, weekday: rule.weekday };
      break;
  }
  if (rule.window && offersWindow(rule.every, caps)) t = { ...t, between: { ...ACTIVE_WINDOW } };
  if (apiAccepts('scheduleCadence', caps)) t = { ...t, timezone: timeZone };
  return t;
}

/** The rule in the words the card shows and an error names: "Every weekday at 09:00". */
export function describeSchedule(rule: SchedRule): string {
  const every = rule.every === 'weekday' ? 'weekday' : (EVERY_LABELS.find((e) => e.value === rule.every)?.label ?? rule.every);
  const day = rule.every === 'week' ? ` on ${WEEKDAY_CHOICES.find((d) => d.value === rule.weekday)?.label ?? 'Monday'}` : '';
  const at = hasTimeOfDay(rule.every) ? ` at ${rule.at}` : '';
  const win = rule.window && (rule.every === 'hour' || isMinutes(rule.every)) ? `, only ${ACTIVE_WINDOW.from}–${ACTIVE_WINDOW.to}` : '';
  return `Every ${every}${day}${at}${win}`;
}

/** "About 54 runs a day. Each run uses some of your Claude limit." The figure comes from the API's own cadence arithmetic. */
export function runsNote(rule: SchedRule, timeZone: string, caps?: Caps): string {
  const tail = ' Each run uses some of your Claude limit.';
  if (rule.every === 'weekday') return `5 runs a week.${tail}`;
  if (rule.every === 'week') return `1 run a week.${tail}`;
  const perDay = scheduleRunsPerDay(scheduleTrigger(rule, timeZone, caps), timeZone);
  if (perDay === 1) return `1 run a day.${tail}`;
  return `About ${perDay ?? 0} runs a day.${tail}`;
}

/** Problems the API would refuse, said before the round trip (empty = fine). The API's own sentences. */
export function scheduleRuleProblems(rule: SchedRule, timeZone: string, caps?: Caps): string[] {
  return scheduleProblems(scheduleTrigger(rule, timeZone, caps));
}

/** "Europe/Madrid (UTC+1)": the zone times are read in, as the card names it. */
export function zoneLabel(timeZone: string, now: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(part);
    const off = m?.[1] ? `UTC${m[1] === '-' ? '−' : '+'}${Number(m[2])}${m[3] && m[3] !== '00' ? `:${m[3]}` : ''}` : 'UTC';
    return `${timeZone.replace(/_/g, ' ')} (${off})`;
  } catch {
    return 'your time zone';
  }
}

/** The viewer's zone: the browser's. (There is no time-zone preference to read yet: see the ticket.) */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
