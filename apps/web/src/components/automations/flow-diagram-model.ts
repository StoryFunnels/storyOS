import { describeRelativeDateCondition } from '@/components/views/relative-date';
import type { Field } from '@/components/table-view/use-table-data';

/**
 * #283 — the single derivation from a rule's stored shape (trigger + condition +
 * actions[]) to something drawable. No schema change, no new storage: the rule
 * row stays the source of truth, this is a pure projection of it.
 *
 * Deliberately loosely typed rather than pinned to `AutomationAction`/
 * `AutomationTrigger` from `@storyos/schemas`: AC #2 requires that a trigger or
 * action type this derivation doesn't recognise still renders something honest
 * instead of throwing, and the web app's own `ButtonAction` union (#152) is
 * narrower than the full action schema (missing `create_records`/`run_agent`)
 * — a strict schema type here would make "unrecognised" a compile error instead
 * of a real, reachable case.
 */
export interface DiagramCondition {
  field: string;
  op: string;
  value?: unknown;
}

export interface DiagramTrigger {
  type: string;
  field_id?: string;
  relation_field_id?: string;
  direction?: 'link' | 'unlink';
  every?: string;
  at?: string;
  /** Interval for every:'minutes' (API-created rules). */
  minutes?: number;
  /** IANA zone; absent means the server's own zone. */
  timezone?: string;
  /** Weekly rules: 0 = Sunday. */
  weekday?: number;
  /** Minutes/hour/day rules: the days it runs on (0 = Sunday). */
  weekdays?: number[];
  /** Active window for minutes/hour rules. */
  between?: { from: string; to: string };
}

export interface DiagramAction {
  type: string;
  condition?: DiagramCondition | null;
}

export interface DiagramRule {
  trigger: DiagramTrigger;
  condition?: DiagramCondition | null;
  actions: DiagramAction[];
}

export interface FlowActionStep {
  index: number;
  label: string;
  /** #245/#274's per-action condition, drawn as a branch/gate on this action. */
  branchLabel: string | null;
  /** #246 — create_records makes a dynamic number of records: a fan-out. */
  fanOut: boolean;
  /** false when `label` fell back to a raw type name (AC #2). */
  recognized: boolean;
}

export interface FlowDiagram {
  triggerLabel: string;
  conditionLabel: string | null;
  actions: FlowActionStep[];
}

/** Mirrors button-actions-editor.tsx's option labels — same words, one place. */
const ACTION_LABELS: Record<string, string> = {
  set_values: 'Set fields on this record',
  create_record: 'Create a record',
  create_records: 'Create records',
  add_comment: 'Add a comment',
  notify_user: 'Notify a person',
  update_linked: 'Update linked records',
  send_slack_message: 'Send a Slack message',
  send_webhook: 'Send a webhook',
  run_agent: 'Run an agent',
  send_email: 'Send an email',
  http_request: 'Call an API (HTTP request)',
  post_social: 'Post to LinkedIn or X',
};

const OP_LABELS: Record<string, string> = {
  is_empty: 'is empty',
  not_empty: 'is not empty',
};

/** Extended from automations-panel.tsx's `triggerSentence` — same sentences,
 * plus #270's record_linked (relation field + link/unlink direction), which
 * the original never handled (fell through to the raw trigger type). */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** [1,2,3,4,5] -> "Mon-Fri"; [1,3] -> "Mon, Wed". Runs of 3+ collapse; the week reads Mon first, Sunday last. */
function weekdaysLabel(days: number[]): string {
  const pos = [...new Set(days)].filter((d) => d >= 0 && d <= 6).map((d) => (d + 6) % 7).sort((x, y) => x - y);
  const name = (p: number) => DAY_NAMES[(p + 1) % 7] ?? '';
  const parts: string[] = [];
  let i = 0;
  while (i < pos.length) {
    let j = i;
    while (j + 1 < pos.length && (pos[j + 1] ?? -1) === (pos[j] ?? -2) + 1) j++;
    const first = pos[i] ?? 0;
    const last = pos[j] ?? 0;
    if (j - i >= 2) parts.push(`${name(first)}-${name(last)}`);
    else for (let k = first; k <= last; k++) parts.push(name(k));
    i = j + 1;
  }
  return parts.join(', ');
}

export function triggerLabel(trigger: DiagramTrigger, fields: Field[]): string {
  if (trigger.type === 'record_created') return 'When a record is created';
  if (trigger.type === 'record_updated') {
    const field = fields.find((f) => f.id === trigger.field_id);
    return field ? `When "${field.displayName}" changes` : 'When a record changes';
  }
  if (trigger.type === 'record_linked') {
    const field = fields.find((f) => f.id === trigger.relation_field_id);
    const via = field ? `"${field.displayName}"` : 'a relation';
    if (trigger.direction === 'link') return `When a record is linked via ${via}`;
    if (trigger.direction === 'unlink') return `When a record is unlinked via ${via}`;
    return `When a record is linked or unlinked via ${via}`;
  }
  if (trigger.type === 'schedule') {
    // Never print the word "undefined"; and only say "at HH:MM" where the cadence has a time of day
    // (the editor hides the time for hourly, so a stored default must not surface on the canvas).
    const every = trigger.every;
    let cadence: string;
    if (every === 'minutes') {
      cadence = trigger.minutes ? `Every ${trigger.minutes} minutes` : 'Every few minutes';
    } else if (every === 'hour') {
      cadence = 'Every hour';
    } else if (every) {
      cadence = `Every ${every}${trigger.at ? ` at ${trigger.at}` : ''}`;
    } else {
      cadence = `On a schedule${trigger.at ? ` at ${trigger.at}` : ''}`;
    }
    const extras: string[] = [];
    if (trigger.between) extras.push(`${trigger.between.from}-${trigger.between.to}`);
    if (every === 'week' && trigger.weekday !== undefined && DAY_NAMES[trigger.weekday]) {
      cadence = cadence.replace('Every week', `Every week on ${DAY_NAMES[trigger.weekday]}`);
    } else if (trigger.weekdays?.length) extras.push(weekdaysLabel(trigger.weekdays));
    return `${cadence}${extras.length ? `, ${extras.join(', ')}` : ''} (${trigger.timezone ?? 'server time'})`;
  }
  if (trigger.type === 'webhook_received') return 'A webhook is received';
  return trigger.type;
}

/** A select/status field's condition value is stored as option id(s) (#274's
 * buildCondition) — not legible on its own, so resolve each id through the
 * field's own options the same way the cell renderer would. */
function resolveOptionLabels(rawValue: unknown, field: Field | undefined): string {
  const ids = Array.isArray(rawValue) ? rawValue : [rawValue];
  return ids
    .map((id) => field?.options?.find((o) => o.id === id)?.label ?? String(id))
    .join(', ');
}

/** Human label for a condition clause — shared shape for the rule-level
 * condition and every per-action "Only if…" branch. */
export function conditionLabel(condition: DiagramCondition | null | undefined, fields: Field[]): string | null {
  if (!condition) return null;
  const field = fields.find((f) => f.apiName === condition.field);
  const name = field ? `"${field.displayName}"` : condition.field;
  const opLabel = OP_LABELS[condition.op] ?? condition.op.replace(/_/g, ' ');
  if (condition.value === undefined) return `${name} ${opLabel}`;
  // #1155 — a relative date (`$date:-90d`, the API's token) reads in words, as it does in the filter builder.
  const relative = describeRelativeDateCondition(condition.op, condition.value);
  if (relative) return `${name} ${relative}`;
  const value = field?.options?.length
    ? resolveOptionLabels(condition.value, field)
    : Array.isArray(condition.value)
      ? condition.value.join(', ')
      : String(condition.value);
  return `${name} ${opLabel} ${value}`;
}

export function actionLabel(action: DiagramAction): { label: string; recognized: boolean } {
  const known = ACTION_LABELS[action.type];
  if (known) return { label: known, recognized: true };
  return { label: action.type.replace(/_/g, ' '), recognized: false };
}

/** The one place a rule's shape becomes drawable nodes — slice C (#285) edits
 * this same model rather than deriving its own (#375/#380/#383/#399/#408/#422
 * are all the cost of not doing that). */
export function deriveFlowDiagram(rule: DiagramRule, fields: Field[]): FlowDiagram {
  return {
    triggerLabel: triggerLabel(rule.trigger, fields),
    conditionLabel: conditionLabel(rule.condition, fields),
    actions: rule.actions.map((action, index) => {
      const { label, recognized } = actionLabel(action);
      return {
        index,
        label,
        branchLabel: conditionLabel(action.condition, fields),
        fanOut: action.type === 'create_records',
        recognized,
      };
    }),
  };
}
