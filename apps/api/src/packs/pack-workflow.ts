import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * #824 — the gallery card's hero is the pack's WORKFLOW, because it is the one
 * piece of pack content that differs on every card (automations and agents are
 * 1 on all eight packs; the counts cannot help anyone choose).
 *
 * The states are read from the pack's OWN manifest (`manifest.states`), so the
 * card cannot drift from what installs. A bare list of every option is not always
 * the pipeline a person means, though: Support Inbox's list ends in Blocked and
 * Canceled, which are exits rather than steps, and Consulting's Won and Lost are
 * two outcomes of one step. Where the whole list is wrong, `PACK_PIPELINES` names
 * the shape — and `packWorkflow` REFUSES a label the manifest does not contain,
 * so renaming a state in a pack fails a test instead of silently leaving a stale
 * word on the card.
 *
 * A stage is an array: one label is a step; several are ALTERNATIVES at that step
 * (rendered "Won / Lost"), which is a different relation from states hidden in
 * sequence and must not share a mark with it (Dara's v4 semantic catch).
 */
export interface PackWorkflow {
  /** The database and field the states belong to — the card's kicker, from the manifest. */
  database: string;
  field: string;
  stages: string[][];
}

/** Packs whose full option list is not the pipeline. Absent = every option, in order. */
export const PACK_PIPELINES: Record<string, Array<string | string[]>> = {
  // Canceled is an exit, not a step.
  'dev-project-os': ['Triage', 'Backlog', 'To Do', 'In Progress', 'In Review', 'Done'],
  // Blocked and Canceled are exits, not steps.
  'support-inbox': ['New', 'To Do', 'In Progress', 'Review', 'Done'],
  // One step with two outcomes.
  'consulting-os': ['Draft', 'Sent', 'Negotiating', ['Won', 'Lost']],
  // One state followed by its four possible outcomes.
  'coaching-os': ['Scheduled', ['Done', 'No-show', 'Rescheduled', 'Canceled']],
};

export function packWorkflow(entry: PackRegistryEntry): PackWorkflow | null {
  const state = entry.manifest.states.find((s) => s.options.length > 0);
  if (!state) return null;
  const labels = state.options.map((o) => o.label);
  const pipeline = PACK_PIPELINES[entry.slug];
  if (!pipeline)
    return { database: state.database, field: state.field, stages: labels.map((l) => [l]) };

  const stages = pipeline.map((s) => (Array.isArray(s) ? s : [s]));
  const unknown = stages.flat().filter((l) => !labels.includes(l));
  if (unknown.length > 0) {
    throw new Error(
      `PACK_PIPELINES["${entry.slug}"] names ${unknown.map((l) => `"${l}"`).join(', ')}, which ${state.database}.${state.field} does not have. ` +
        `Its options are: ${labels.join(', ')}.`,
    );
  }
  return { database: state.database, field: state.field, stages };
}
