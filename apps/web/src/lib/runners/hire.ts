import type { FieldWithOptions } from './agents';

/**
 * Ticket #1139 AC3 — hiring an agent from the web: a record in the Agents database. There is no server "hire" endpoint (ADR-0021
 * §11 question 13, ruled: confirmed), so the card writes the same record the Agents table does, with the API's own value
 * formats (a select takes an OPTION ID, a rich-text field takes BLOCKS; the API refuses anything else).
 *
 * An agent hired here is "Your own AI" and enabled: that is the mode a Runner serves, and the one this whole screen exists for.
 * It is hired whether or not any Runner exists (`hireState`, `runs-on.ts`): the agent just waits for one.
 */
export interface HireInput {
  name: string;
  goal: string;
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
  return {
    [title.apiName]: input.name.trim(),
    ...(goal ? { goal: [{ type: 'paragraph', content: [{ type: 'text', text: goal }] }] } : {}),
    ai_mode: own.id,
    enabled: true,
  };
}

/** The Hire button's rule: a name. Not a Runner: see `hireState`. */
export function canSubmitHire(name: string, busy: boolean): boolean {
  return name.trim().length > 0 && !busy;
}
