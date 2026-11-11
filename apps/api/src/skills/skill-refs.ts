/**
 * ticket #1110 — how an agent's "Skills" field names a skill.
 *
 * The field is one skill per line. A line is either
 *   `Triage`                      a NAME only: how a person types one, and how every agent that predates this ticket stores it, or
 *   `Triage [skill:<uuid>]`       a name (the LABEL, the portable text a pack carries) plus the ID of the skill it was linked to.
 *
 * The id is what a run, a pack update and an export follow, so renaming the skill does not break the agent. The label is not rewritten
 * when the skill is renamed: it is the name the skill had when it was linked, and the pack's "did a person edit this agent" hash is
 * taken over labels only (`skillLabelsText`), so a link being added or followed never flips an untouched agent to "edited".
 * A line that is nothing but `[skill:<uuid>]` is also an id (its label is empty).
 */
export interface SkillRef {
  /** The text before the id: the name this line was linked under, or the whole line when it carries no id. */
  label: string;
  /** The linked skill's id; undefined for a name-only line. */
  id?: string;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LINE = new RegExp(`^(.*?)\\s*\\[skill:(${UUID})\\]\\s*$`);

export function parseSkillRefs(raw: unknown): SkillRef[] {
  if (typeof raw !== 'string') return [];
  const out: SkillRef[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = LINE.exec(t);
    if (m) out.push({ label: m[1]!.trim(), id: m[2]!.toLowerCase() });
    else out.push({ label: t });
  }
  return out;
}

export function formatSkillRef(ref: SkillRef): string {
  return ref.id ? `${ref.label} [skill:${ref.id}]`.trim() : ref.label;
}

export function formatSkillRefs(refs: SkillRef[]): string {
  return refs.map(formatSkillRef).join('\n');
}

/** The labels only, one per line: what the portable manifest names and what the pack "edited" hash is taken over. */
export function skillLabelsText(raw: unknown): string {
  return parseSkillRefs(raw)
    .map((r) => r.label)
    .filter(Boolean)
    .join('\n');
}

/** What to show a person or a tool as the name of a line: its label, or the id when the line has none. */
export function skillRefDisplay(ref: SkillRef): string {
  return ref.label || ref.id || '';
}
