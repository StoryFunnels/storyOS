/**
 * Ticket #719 — resolve the HUMAN label of a select / workflow / multi-select option to its option id, in ONE place.
 *
 * A person (and a model) writes "Done"; storage holds an option id, and the record validator only accepts a real id. The MCP tool layer
 * resolved labels for its own writes; an automation's `set_values` could not, so the label an admin typed into the rule failed the run
 * with "unknown option id". This is that mapping lifted out of the MCP package so the API's automation path and the MCP read the same
 * rule, not two copies that drift.
 *
 * A value is matched as an option ID first, then as a label ignoring case. A value that is neither is returned UNCHANGED, and reported in
 * `unresolved`: the MCP layer ignores that list and lets the API answer (as it always did), an automation turns it into a run error that
 * names the field and the valid labels. Non-string values (null, a number, an object) and fields with no options are left alone.
 *
 * ZOD-FREE ON PURPOSE (the MCP image imports this by subpath; see `packages/mcp/src/bundle-safety.test.ts`).
 */
export interface LabelledField {
  apiName: string;
  /** For a message a person reads; falls back to `apiName`. */
  displayName?: string;
  type: string;
  options?: ReadonlyArray<{ id: string; label: string }>;
}

export interface UnresolvedLabel {
  field: string;
  given: string;
  valid: string[];
}

export function resolveOptionLabels(
  fields: ReadonlyArray<LabelledField>,
  values: Record<string, unknown>,
): { values: Record<string, unknown>; unresolved: UnresolvedLabel[] } {
  const byApi = new Map(fields.map((f) => [f.apiName, f]));
  const out: Record<string, unknown> = { ...values };
  const unresolved: UnresolvedLabel[] = [];
  for (const [key, value] of Object.entries(values)) {
    const f = byApi.get(key);
    if (!f?.options?.length) continue;
    const options = f.options;
    const toId = (v: unknown): unknown => {
      const hit = options.find((o) => o.id === v || o.label.toLowerCase() === String(v).toLowerCase());
      if (hit) return hit.id;
      // An empty string is "nothing given", not a wrong label: leave it for the validator, as before.
      if (typeof v === 'string' && v.trim() !== '') unresolved.push({ field: f.displayName ?? f.apiName, given: v, valid: options.map((o) => o.label) });
      return v;
    };
    // A workflow is single-select-shaped (#172): resolved like a select.
    if ((f.type === 'select' || f.type === 'workflow') && typeof value === 'string') out[key] = toId(value);
    else if (f.type === 'multi_select' && Array.isArray(value)) out[key] = value.map(toId);
  }
  return { values: out, unresolved };
}

/** The sentence an automation run shows for a label that matches no option: the field, what was given, and every valid label. */
export function describeUnresolvedLabels(unresolved: ReadonlyArray<UnresolvedLabel>): string {
  return unresolved.map((u) => `"${u.field}" has no option "${u.given}". Valid options: ${u.valid.join(', ')}.`).join(' ');
}
