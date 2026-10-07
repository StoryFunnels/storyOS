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
};

const OP_LABELS: Record<string, string> = {
  is_empty: 'is empty',
  not_empty: 'is not empty',
};

/** Extended from automations-panel.tsx's `triggerSentence` — same sentences,
 * plus #270's record_linked (relation field + link/unlink direction), which
 * the original never handled (fell through to the raw trigger type). */
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
    return `Every ${trigger.every}${trigger.at ? ` at ${trigger.at}` : ''} (server time)`;
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
