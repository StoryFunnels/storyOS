/**
 * #978 (part 1) — what the pack update dialog says, as pure functions so every sentence can be tested against the
 * code it describes. The rule for this file: a sentence states what the install code does TODAY, never a hope.
 * (Reads: apps/api/src/agents/architect.service.ts `ensureField`, the agent/view/automation `existing` branches, and
 * packs.service.ts `computeCollisions`.)
 */

import type { PackAgentUpdate, PackDatabaseGains } from '@storyos/schemas';

export interface PackVersion {
  version: string;
  changelog?: string;
  published_at: string;
}

export type PackItemKind = 'database' | 'view' | 'automation' | 'agent';
export type PackItemAction = 'create' | 'reuse' | 'collision';

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * The versions an update crosses: everything newer than `from` up to and including `to`, newest first. Compared as
 * dotted numbers ("1.10" is after "1.9"), not as text.
 */
export function versionsBetween(versions: PackVersion[], from: string, to: string): PackVersion[] {
  return versions
    .filter((v) => cmp(v.version, from) > 0 && cmp(v.version, to) <= 0)
    .sort((a, b) => cmp(b.version, a.version));
}

export interface ReleaseNotes {
  /** The newest version's entry: "What's new in 1.5". Null when no version data exists at all (a built-in pack). */
  latest: PackVersion | null;
  /** The versions skipped over, newest first. */
  earlier: PackVersion[];
  /** True when no crossed version carries any author note. */
  noNotes: boolean;
}

export function releaseNotes(
  versions: PackVersion[] | undefined,
  from: string,
  to: string,
): ReleaseNotes {
  const crossed = versionsBetween(versions ?? [], from, to);
  const [latest = null, ...earlier] = crossed;
  return { latest, earlier, noNotes: !crossed.some((v) => (v.changelog ?? '').trim() !== '') };
}

/** "the Budget field", "3 fields it needs: Health, Industry, Monthly Value". */
function listed(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a reused database GAINS, from the preview's own `gains` (#982), as sentences a person reads. Empty gains say
 * so ("Nothing to add.") rather than leaving the row silent, because "kept as it is" alone hid that the install
 * adds fields. `not_applied` is said out loud with its reason, and a state that STOPS the install is not softened.
 */
export function gainsSentences(gains: PackDatabaseGains): string[] {
  const out: string[] = [];
  const f = gains.fields.map((x) => x.name);
  if (f.length === 1) out.push(`Adds the ${f[0]} field.`);
  else if (f.length > 1) out.push(`Adds ${f.length} fields it needs: ${f.join(', ')}.`);
  for (const o of gains.options) out.push(`Adds ${listed(o.labels)} to ${o.field}.`);
  if (gains.views.length === 1) out.push(`Adds the ${gains.views[0]} view.`);
  else if (gains.views.length > 1) out.push(`Adds ${gains.views.length} views: ${gains.views.join(', ')}.`);
  for (const n of gains.not_applied)
    out.push(
      n.blocks_install
        ? `Can’t install: ${n.name} — ${n.reason}`
        : `Not applied: ${n.name} — ${n.reason}`,
    );
  return out.length > 0 ? out : ['Nothing to add.'];
}

/**
 * The note a row carries, or null when there is nothing to say: a NEW item is the common case and gets no row note
 * (the dialog says "All new" once). `action` is the preview API's own classification (`create` / `reuse` /
 * `collision`); the sentence adds only what the install code does for that kind of thing.
 */
export function itemEffect(
  kind: PackItemKind,
  action: PackItemAction,
  gains?: PackDatabaseGains,
): string | null {
  if (action === 'create') return null;
  const what = gains ? ` ${gainsSentences(gains).join(' ')}` : '';
  if (action === 'collision') {
    if (kind === 'database')
      return `You already have a database with this name. The pack can use yours and add the fields it needs — nothing in it is removed.${what}`;
    return 'You already have one with this name. You choose what happens.';
  }
  switch (kind) {
    case 'database':
      // ensureField: a field the pack needs is added unless one of that name exists; nothing existing is edited.
      return `Already in your workspace — kept as it is.${what}`;
    case 'agent':
      // An agent that exists but carries no `agent_update` was not installed by an earlier install of THIS pack
      // (apps/api packs.service.ts attaches `agent_update` only to a `reuse` agent this pack made): it is left alone.
      // An agent this pack DID install is described by `agentEffect`, from the preview's own `agent_update`.
      return 'Already yours — left exactly as it is.';
    default:
      return 'Already there — kept as it is.';
  }
}

/** What a person decides for an agent they changed: keep their version, or take the pack's. Keep mine is the default. */
export type AgentChoice = 'keep' | 'update';

const FIELD_LABEL: Record<PackAgentUpdate['changed_fields'][number], string> = {
  goal: 'goal',
  instructions: 'instructions',
  scopes: 'what it may access',
  approval_policy: 'when it asks for approval',
  ai_mode: 'AI mode',
  skills: 'skills',
};

/** "goal and instructions", "instructions, what it may access and when it asks for approval". */
export function changedFieldsText(fields: PackAgentUpdate['changed_fields']): string {
  const labels = fields.map((f) => FIELD_LABEL[f]);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The two fields that change what an agent is ALLOWED to do, so they are called out, never folded into "instructions". */
export function changesWhatItMayDo(fields: PackAgentUpdate['changed_fields']): boolean {
  return fields.includes('scopes') || fields.includes('approval_policy');
}

export interface AgentEffect {
  headline: string;
  detail?: string;
  /** True only for `edited_needs_choice`: the dialog must show Keep mine / Take update. */
  needsChoice: boolean;
}

/**
 * One agent's effect, stated from the preview API's `agent_update` (never guessed): `will_update` (unchanged since
 * the pack installed it, so the update applies), `unchanged` (already what the pack says), or `edited_needs_choice`
 * (the person changed it, or its origin is unknown and it is treated as changed, so nothing is overwritten silently).
 */
export function agentEffect(update: PackAgentUpdate): AgentEffect {
  if (update.status === 'unchanged')
    return { headline: 'Agent: already matches this version. Nothing to do.', needsChoice: false };
  if (update.status === 'will_update') {
    return {
      headline: `Agent: will be updated to this version (${changedFieldsText(update.changed_fields)} change).`,
      detail: 'You haven’t changed it since the pack installed it.',
      needsChoice: false,
    };
  }
  return {
    headline: 'You’ve changed this agent. Keep yours, or take the pack’s update.',
    detail:
      update.reason === 'unknown_origin'
        ? 'It was installed before changes were tracked, so it is treated as changed and your version is kept unless you choose otherwise.'
        : `The pack’s version differs in its ${changedFieldsText(update.changed_fields)}.`,
    needsChoice: true,
  };
}

/**
 * The install `resolutions` for the agents: ONLY an edited agent the person chose to update gets `{action:'update'}`.
 * Keep mine sends nothing (the API leaves an edited agent alone without a resolution), and the API refuses `update`
 * for anything that is not an edited agent, so this never offers one.
 */
export function agentResolutions(
  agents: Array<{ name: string; agent_update?: PackAgentUpdate }>,
  choices: Record<string, AgentChoice>,
): Record<string, { action: 'update' }> {
  const out: Record<string, { action: 'update' }> = {};
  for (const a of agents) {
    if (a.agent_update?.status === 'edited_needs_choice' && choices[a.name] === 'update')
      out[a.name] = { action: 'update' };
  }
  return out;
}
