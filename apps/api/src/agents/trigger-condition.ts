import { filterSchema } from '@storyos/schemas';
import type { FilterNode } from '@storyos/schemas';

/**
 * ticket #1324 follow-up - a trigger's CONDITION: a record filter (the AST saved views and automation conditions use) that must match
 * for the trigger to wake its agent. Stored on the Agent Triggers record as JSON text in the `condition` field, so it needs no migration.
 *
 * Fail CLOSED is the whole point of the module: a condition that cannot be read is `invalid`, never "no condition". A trigger guarding
 * a Do Not Contact list that quietly became "wake for everyone" the day its JSON was edited badly would be worse than having no guard.
 */
export type TriggerCondition = { kind: 'none' } | { kind: 'filter'; filter: FilterNode } | { kind: 'invalid'; reason: string };

/** The cap on the stored text: a trigger's filter stays a small, reviewable thing. */
export const TRIGGER_CONDITION_MAX_CHARS = 4000;

/** Read the stored value (a JSON string, or already an object if it came in through an API as one). Empty / null / unset = none. */
export function readTriggerCondition(raw: unknown): TriggerCondition {
  if (raw === undefined || raw === null) return { kind: 'none' };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { kind: 'none' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: 'invalid', reason: 'the condition is not valid JSON' };
    }
  }
  // A field that is absent, null or empty text is NO condition. The JSON text `null` (or an array, number, string or boolean) is a
  // value somebody wrote that is not a filter: INVALID, which fails closed. Reading it as "none" would turn a broken guard into no guard.
  const parsed = filterSchema.safeParse(value);
  if (!parsed.success) return { kind: 'invalid', reason: `the condition is not a valid filter: ${parsed.error.issues[0]?.message ?? 'unreadable'}` };
  return { kind: 'filter', filter: parsed.data };
}

/** The text a condition is stored as. */
export function writeTriggerCondition(filter: FilterNode): string {
  return JSON.stringify(filter);
}
