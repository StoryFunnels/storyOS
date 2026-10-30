import { DEFAULT_WORKFLOW_OPTIONS } from '@storyos/schemas';
import type { OptionDraft } from './field-dialog-shared';

/**
 * #1151 — what the Add field dialog shows for a new Workflow/Status field. It is built FROM `DEFAULT_WORKFLOW_OPTIONS`, the constant the
 * API applies (#1087), never from a second copy of the labels, so what the dialog pre-fills and what the server would create cannot drift.
 * Keys are negative so they can never collide with the editor's own counter (which starts at 0).
 */
export function seedWorkflowOptions(): OptionDraft[] {
  return DEFAULT_WORKFLOW_OPTIONS.map((o, i) => ({ key: -(i + 1), label: o.label, color: o.color }));
}

/** True while the options are still exactly the pre-filled three — nobody has edited, added, removed or recoloured any. */
export function isUntouchedWorkflowSeed(options: OptionDraft[]): boolean {
  return (
    options.length === DEFAULT_WORKFLOW_OPTIONS.length &&
    options.every(
      (o, i) => o.label === DEFAULT_WORKFLOW_OPTIONS[i]!.label && o.color === DEFAULT_WORKFLOW_OPTIONS[i]!.color && !o.icon,
    )
  );
}

/**
 * The options after the type picker moves from `from` to `to`. Entering workflow with nothing typed yet pre-fills the three states;
 * leaving workflow takes the pre-fill back out only if it is untouched (a select must not inherit "To do / In progress / Done" the user
 * never asked for), and keeps anything the user has edited.
 */
export function optionsAfterTypeChange(from: string, to: string, options: OptionDraft[]): OptionDraft[] {
  if (to === 'workflow' && options.length === 0) return seedWorkflowOptions();
  if (from === 'workflow' && to !== 'workflow' && isUntouchedWorkflowSeed(options)) return [];
  return options;
}
