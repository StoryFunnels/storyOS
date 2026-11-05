/**
 * Pure builders for @/# rich-text mentions (#139, extends #140).
 *
 * Kept dependency-free (no BlockNote/React imports) so the mapping — search hit
 * -> stored mention node, and the "#<number> Title" picker label — is unit
 * testable in the node vitest env without booting the editor.
 */

/** Stored inline-mention props. The id is durable; label/db are snapshots so a
 *  mention still renders (and a #record stays navigable) before it re-resolves. */
export interface MentionProps {
  kind: string;
  id: string;
  label: string;
  db: string;
}

/** A record hit from the grant-scoped workspace search endpoint. */
export interface SearchRecord {
  id: string;
  title: string;
  database_id: string;
  database_name: string;
  number?: number | null;
  /** #178: owning database colour (DbColorMarker cylinder), owning space name
   *  (for the `space › database` breadcrumb) and the coarse entity kind — all
   *  optional so pre-#178 payloads (and markdown-sourced rows) still render. */
  database_color?: string | null;
  space_name?: string | null;
  type?: string;
}

/** A workspace member as offered in the @ picker. */
export interface MemberUser {
  id: string;
  name: string;
  image?: string | null;
}

/** The slice of an agent (lib/runners/agents.ts `AgentView`) the @ picker reads. */
export interface MentionAgent {
  id: string;
  name: string;
  enabled: boolean;
  aiMode: 'Non-AI' | 'Your own AI' | 'StoryOS AI' | null;
}

/**
 * Can an @-mention of this agent wake it? The ONE named predicate for "mentionable agent" (CLAUDE.md: never inline a
 * capability gate). It mirrors the server's authority, `AgentWakesService.enqueue` in apps/api/src/runners/agent-wakes.service.ts:
 * it skips `agent_disabled` unless the agent is enabled and `not_own_ai` unless its AI mode is "Your own AI" (a "StoryOS AI"
 * agent is not woken by a mention today). A row that is not mentionable is still LISTED, disabled, with the reason, so the
 * picker never answers "No matches" about an agent that exists.
 */
export function agentMentionState(a: Pick<MentionAgent, 'enabled' | 'aiMode'>): { ok: true } | { ok: false; reason: string } {
  if (!a.enabled) return { ok: false, reason: 'Switched off' };
  if (a.aiMode === 'Your own AI') return { ok: true };
  if (a.aiMode === 'Non-AI') return { ok: false, reason: 'Runs without an AI' };
  return { ok: false, reason: 'Not on your own AI' };
}

/**
 * Mention node props for an agent picked from the @ menu. `kind: 'agent'` + `id` is exactly what the server parses
 * (`collectMentions` in apps/api/src/mentions/mentions.service.ts feeds `wakeMentionedAgents` in comments.service.ts); `label` is
 * the snapshot a chip falls back on. Pinned by a test, since nothing fails to compile if the two drift.
 */
export function agentMentionProps(a: Pick<MentionAgent, 'id' | 'name'>): MentionProps {
  return { kind: 'agent', id: a.id, label: a.name, db: '' };
}

/** An agent row for the @ picker: matched by name like people, mentionable ones first (stable within each group). */
export function agentPickerRows<T extends MentionAgent>(
  agents: T[],
  query: string,
): Array<{ agent: T; disabledReason: string | null }> {
  const rows = filterMembers(agents, query).map((agent) => {
    const state = agentMentionState(agent);
    return { agent, disabledReason: state.ok ? null : state.reason };
  });
  return [...rows.filter((r) => !r.disabledReason), ...rows.filter((r) => r.disabledReason)];
}

/** Mention node props for a person picked from the @ menu. */
export function userMentionProps(u: MemberUser): MentionProps {
  return { kind: 'user', id: u.id, label: u.name, db: '' };
}

/** Mention node props for a record picked from the # menu — carries `db` so the
 *  chip links to the record and can resolve its live title. */
export function recordMentionProps(r: SearchRecord): MentionProps {
  return { kind: 'record', id: r.id, label: r.title ?? '', db: r.database_id };
}

/**
 * The inline content inserted at the caret: the mention node plus a trailing
 * space. This is exactly what BlockNote serializes into the stored document, so
 * a mention survives save/reload as structured content (not a flattened string).
 */
export function mentionInsertContent(props: MentionProps): [{ type: 'mention'; props: MentionProps }, string] {
  return [{ type: 'mention', props }, ' '];
}

/** Row shape for the # record picker: the faint #<number>, the title, the
 *  owning database (as subtext), plus #178's db colour and owning space. Missing
 *  numbers degrade to null (no "#"); missing colour/space degrade to null so the
 *  marker / space-prefix are simply omitted. */
export function recordRowLabel(r: SearchRecord): {
  number: number | null;
  title: string;
  database: string;
  color: string | null;
  space: string | null;
} {
  return {
    number: r.number ?? null,
    title: r.title || 'Untitled',
    database: r.database_name,
    color: r.database_color ?? null,
    space: r.space_name ?? null,
  };
}

/** #178: the `space › database` breadcrumb subtext for a picker row. Falls back
 *  to the database alone when the owning space name is unknown. */
export function recordBreadcrumb(space: string | null, database: string): string {
  return space ? `${space} › ${database}` : database;
}

/** Case-insensitive name filter for the @ picker's local member list. */
export function filterMembers<T extends { name: string }>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return members;
  return members.filter((m) => m.name.toLowerCase().includes(q));
}

/** An active @/# trigger detected in a plain-text composer input (#171). */
export interface MentionTrigger {
  /** Which picker to open. */
  kind: '@' | '#';
  /** The text typed after the trigger char, up to the caret (the filter query). */
  query: string;
  /** Index of the trigger char in the source text (so callers can strip it). */
  start: number;
}

/**
 * Detect an in-progress @/# mention in a plain-text comment composer (#171),
 * mirroring how the rich-text editor's suggestion menus trigger inline. Scans
 * left from the caret for a `@`/`#` that begins a token (at string start or
 * after whitespace); the run between it and the caret is the live query and may
 * not itself contain whitespace. Returns null when the caret isn't inside such a
 * token — so a lone "a@b" email or a completed "@Ada word" never re-opens it.
 */
export function detectMentionTrigger(text: string, caret: number): MentionTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '@' || ch === '#') {
      const boundary = i === 0 || /\s/.test(text[i - 1]!);
      if (!boundary) return null;
      const query = text.slice(i + 1, caret);
      if (/\s/.test(query)) return null;
      return { kind: ch, query, start: i };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}
