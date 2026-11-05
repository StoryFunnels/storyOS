/**
 * #1149 — the install review's pure parts: what a pack leads with (`why`, `can`), its database map, and the person's choice
 * about a same-named database in ANOTHER space.
 *
 * Pure, so each rule is a test: the sentences are the product here, and a heading with nothing under it, a map invented
 * from nothing, or a choice that defaults to touching the person's other space would each ship without failing to compile.
 *
 * Everything is read from the API (`GET /packs/registry`: `why`, `can`, `relations`; `POST /packs/preview`: each database's
 * `existing_elsewhere`). Nothing is hard-coded per pack — that was the point of #1145.
 */
import type { PackPreviewItem } from '@storyos/schemas';

export interface PackRelation {
  from: string;
  to: string;
  cardinality: 'one_to_many' | 'many_to_many';
  from_field?: string;
  to_field?: string;
}

/**
 * What the API's `existing_elsewhere` says (packs #1156, `candidates` #1176). Derived from the schema (`packPreviewItemSchema`), the ONE
 * place the shape lives, so the web cannot drift from it with its own cast. A type-only import: erased at runtime, so tests need no build.
 */
export type ExistingElsewhere = NonNullable<PackPreviewItem['existing_elsewhere']>;
/** One same-named database the person could pick (#1176): only databases they can EDIT are listed, each with its own verdict. */
export type ReuseCandidate = NonNullable<ExistingElsewhere['candidates']>[number];

/** The registry fields the review reads. All optional: a community pack, an old API or a pack with no copy simply has none. */
export interface ReviewSource {
  why?: string | null;
  can?: string[] | null;
  relations?: PackRelation[] | null;
}

/**
 * The lead of a review: the one sentence, then the "can" lines. A null/blank `why` yields NO sentence (never a placeholder), no
 * `can` lines yield no list, and `show` is false when neither exists, so the caller renders nothing — no heading, no gap.
 */
export function reviewLead(src: ReviewSource): { why: string | null; can: string[]; show: boolean } {
  const why = src.why?.trim() ? src.why.trim() : null;
  const can = (src.can ?? []).map((c) => c.trim()).filter(Boolean);
  return { why, can, show: why !== null || can.length > 0 };
}

/** One line of the map. `link`: "Tasks → Projects" (the arrow points from the record that holds the link to the one it links to). */
export type MapRow =
  | { kind: 'link'; from: string; op: '→' | '↔'; to: string }
  | { kind: 'self'; name: string; via: string }
  | { kind: 'solo'; name: string }
  | { kind: 'note'; text: string };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The map's rows, from the listing's relations alone. `databaseCount` (the pack's own count) lets it say how many databases
 * have no link at all ("+2 more databases") without naming any it does not know; `soleDatabase` names the lone database of a
 * pack with no relations. With nothing to say it returns [] and the caller draws nothing. `limit` caps the link rows (a card is
 * small), and says how many were left out rather than dropping them silently.
 */
export function mapRows(
  relations: PackRelation[] | null | undefined,
  databaseCount: number,
  opts: { soleDatabase?: string | null; limit?: number } = {},
): MapRow[] {
  const rels = relations ?? [];
  if (rels.length === 0) {
    if (databaseCount === 1) {
      return [
        ...(opts.soleDatabase ? [{ kind: 'solo', name: opts.soleDatabase } as const] : []),
        { kind: 'note', text: 'One database, no links' },
      ];
    }
    return databaseCount > 1 ? [{ kind: 'note', text: `${plural(databaseCount, 'database')}, no links` }] : [];
  }
  const seen = new Set<string>();
  const rows: MapRow[] = [];
  for (const r of rels) {
    const key = `${r.from}|${r.to}|${r.cardinality}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.from === r.to) rows.push({ kind: 'self', name: r.from, via: (r.from_field ?? r.to_field ?? 'itself').toLowerCase() });
    else rows.push({ kind: 'link', from: r.from, op: r.cardinality === 'many_to_many' ? '↔' : '→', to: r.to });
  }
  const linked = new Set(rels.flatMap((r) => [r.from, r.to]));
  const unlinked = Math.max(0, databaseCount - linked.size);
  const shown = opts.limit !== undefined && rows.length > opts.limit ? rows.slice(0, opts.limit) : rows;
  const out: MapRow[] = [...shown];
  if (shown.length < rows.length) out.push({ kind: 'note', text: `+${rows.length - shown.length} more ${rows.length - shown.length === 1 ? 'link' : 'links'}` });
  if (unlinked > 0) out.push({ kind: 'note', text: `+${unlinked} more ${unlinked === 1 ? 'database' : 'databases'}` });
  return out;
}

/** The wording of the choice (Dara, ticket #1149). Kept here so a test can pin every string. */
export const REUSE_COPY = {
  heading: (name: string) => `You already have ${aDatabase(name)} in another space.`,
  /** #1176 — several of them. `total` is how many the person could pick from (the ones they can edit). */
  headingMany: (name: string, total: number) => `You already have ${total} ${name} databases in other spaces.`,
  createManyTitle: (name: string) => `Create a new ${name} database here`,
  useManyTitle: (name: string) => `Use one of your ${name} databases`,
  useManySub: (usable: number, space: string) => (usable === 1 ? `The one in ${space}.` : `${usable} can take this pack. Pick one below.`),
  /** "Issues in StoryOS · 1,172 records"; no number when the API gave none (it always does for a usable one). */
  pickLabel: (name: string, c: Pick<ReuseCandidate, 'space_name' | 'record_count'>) => ({
    main: `${name} in ${c.space_name}`,
    count: c.record_count === undefined ? null : `· ${c.record_count.toLocaleString('en-GB')} ${c.record_count === 1 ? 'record' : 'records'}`,
  }),
  /** Under the list, for the one picked, from its `fields_added` (#1169). [] is a real answer: it already has every field. */
  pickedAdds: (o: { noun: string; space: string; added: string[] | undefined }) =>
    `${o.added === undefined ? '' : o.added.length > 0 ? `Adds ${o.added.join(', ')} to it. ` : 'It already has every field this pack needs. '}` +
    `Nothing in it is removed or renamed. People who can’t open ${o.space} won’t see these ${o.noun}s here.`,
  /** A pick the review no longer trusts (the database is gone, or the server refused it): the sentence that explains the fall-back. */
  stalePick: (name: string) => `The ${name} you picked can’t be used any more, so this pack will create its own.`,
  createTitle: (name: string) => `Create a new ${name} here`,
  createSub: (space: string) => `Empty, in ${space}, with the fields this pack needs.`,
  useTitle: (name: string, space?: string) => (space ? `Use your existing ${name} (in ${space})` : `Use your existing ${name}`),
  /** `count` is a live number; null while loading or when it could not be read — then no number is claimed. */
  existingSub: (o: { noun: string; count: number | null; space: string; its: string; adds: string[] | null }) => {
    const one = o.count === 1;
    const things = one ? o.noun : `${o.noun}s`;
    const lead = o.count === null ? `Your ${things}` : `Your ${o.count} ${things}`;
    return (
      `${lead} ${one ? 'stays where it is' : 'stay where they are'}, and ${o.space} links to ${one ? 'it' : 'them'}. ` +
      `${o.adds === null ? '' : `${o.adds.length > 0 ? `Adds ${o.adds.join(', ')}.` : 'It already has every field this pack needs.'} `}` +
      `Nothing in it is removed or renamed. People who can't open ${o.its} won't see ${one ? 'this' : 'these'} ${things} here.`
    );
  },
} as const;

/** "A", "A and B", "A, B and C". */
export function andList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface ExistingChoice {
  /** The database's name in the pack — what the install's `resolutions` are keyed by. */
  name: string;
  hint: ExistingElsewhere;
}

/**
 * The databases the person must be asked about: those whose preview item carries `existing_elsewhere` and which are not
 * already adopted by an earlier install of this pack (nothing to decide there). A database with no hint gets no row — the
 * review is unchanged for it.
 */
export function existingChoices(databases: Array<{ name: string; existing_elsewhere?: ExistingElsewhere }>): ExistingChoice[] {
  return databases.flatMap((d) => (d.existing_elsewhere && !d.existing_elsewhere.adopted ? [{ name: d.name, hint: d.existing_elsewhere }] : []));
}

/**
 * What the person chose for one database. Only an explicit `use: true` ever reuses anything; the DEFAULT, for every database, is
 * "create a new one". `databaseId` is the pick among several (#1176); unset with `use` means "the first usable one" (the list opens
 * preselected to it), and it is meaningless for the single-candidate row, which sends no id.
 */
export interface ReusePick {
  use: boolean;
  databaseId?: string;
}
export type ReuseSelection = Record<string, ReusePick>;

/**
 * A candidate the person may pick. Mirrors the server's own verdict (`reusable`, from `candidates` in
 * apps/api/src/packs/packs.service.ts, `planAdoptions`): the web never decides compatibility, it only refuses to offer what the server
 * said no to. A candidate with no id cannot be sent, so it is not pickable either.
 */
export function isReusableCandidate(c: ReuseCandidate): boolean {
  return c.reusable === true && c.database_id.length > 0;
}

/**
 * The server words a Linear mirror's refusal as "...synced from Linear..." (apps/api/src/packs/packs.service.ts). There is no flag for
 * it on the candidate, so the review recognises the reason text: used ONLY to phrase the can't-be-used line shorter, never to decide
 * whether something is usable (that is `reusable`).
 */
export function isLinearMirrorReason(reason: string | undefined): boolean {
  return /synced from Linear/i.test(reason ?? '');
}

/**
 * How one database's row is drawn, from its `existing_elsewhere`:
 *  - `single`: at most one database to consider: the two-card row (create new / use your existing one, disabled with the reason when
 *    it cannot be used). The old hint fields drive it, so a server without `candidates` behaves exactly as before.
 *  - `many`: several, and at least one usable: create new (default) / use one of them, with a short list to pick from.
 *  - `none`: several, none usable: one quiet line, no radios (the dead-end disabled radio is gone).
 */
export type ReuseView =
  | { kind: 'single'; hint: ExistingElsewhere }
  | { kind: 'many'; usable: ReuseCandidate[]; unusable: ReuseCandidate[]; total: number }
  | { kind: 'none'; unusable: ReuseCandidate[]; total: number };

export function reuseView(hint: ExistingElsewhere): ReuseView {
  const all = hint.candidates ?? [];
  if (all.length <= 1) {
    // One candidate and a hint that does not carry it (an older server): fill the hint from the candidate so nothing is lost.
    const only = all[0];
    if (!only || hint.database_id) return { kind: 'single', hint };
    return {
      kind: 'single',
      hint: { ...hint, database_id: only.database_id, space_name: only.space_name, reusable: only.reusable, reason: only.reason, record_count: only.record_count, fields_added: only.fields_added },
    };
  }
  // The server lists them in no particular order, and the order moved between two opens of the same review (a pick landed on a
  // different row). So the list is ordered here: the fullest database first (Dara's example leads with the 1,172-record one),
  // ties and the can't-be-used line by space name.
  const bySpace = (a: ReuseCandidate, b: ReuseCandidate) => a.space_name.localeCompare(b.space_name) || a.database_id.localeCompare(b.database_id);
  const usable = all.filter(isReusableCandidate).sort((a, b) => (b.record_count ?? 0) - (a.record_count ?? 0) || bySpace(a, b));
  const unusable = all.filter((c) => !isReusableCandidate(c)).sort(bySpace);
  return usable.length > 0 ? { kind: 'many', usable, unusable, total: all.length } : { kind: 'none', unusable, total: all.length };
}

/** The candidate a `many` row's pick points at: the chosen id, else the first usable one. Null when "use" is off or the id is no longer usable. */
export function pickedCandidate(view: Extract<ReuseView, { kind: 'many' }>, pick: ReusePick | undefined): ReuseCandidate | null {
  if (!pick?.use) return null;
  const id = pick.databaseId ?? view.usable[0]!.database_id;
  return view.usable.find((c) => c.database_id === id) ?? null;
}

/** "Unconfigured is not invalid": a pick that points at a database the review no longer offers (it was deleted, or lost its edit access). */
export function isStalePick(view: ReuseView, pick: ReusePick | undefined): boolean {
  return view.kind === 'many' && pick?.use === true && pickedCandidate(view, pick) === null;
}

/** Whether "use existing" is in effect for one choice: chosen AND the server said it can be used. A disabled card is never in effect. */
function inEffect(c: ExistingChoice, pick: ReusePick | undefined): { databaseId?: string; label: string } | null {
  const view = reuseView(c.hint);
  if (view.kind === 'single') return pick?.use === true && view.hint.reusable ? { label: c.name } : null;
  if (view.kind === 'none') return null;
  const chosen = pickedCandidate(view, pick);
  return chosen ? { databaseId: chosen.database_id, label: `${c.name} (in ${chosen.space_name})` } : null;
}

/** The names whose "use existing" is in effect. */
export function reusedNames(choices: ExistingChoice[], selection: ReuseSelection): string[] {
  return choices.filter((c) => inEffect(c, selection[c.name]) !== null).map((c) => c.name);
}

/**
 * The `resolutions` entries for the install and the confirming preview: `{ Clients: { action: 'reuse' } }` for the one-candidate row
 * (no id: today's behaviour, unchanged), `{ Issues: { action: 'reuse', database_id } }` for a pick among several. Only for what was chosen.
 */
export function reuseResolutions(choices: ExistingChoice[], selection: ReuseSelection): Record<string, { action: 'reuse'; database_id?: string }> {
  return Object.fromEntries(
    choices.flatMap((c) => {
      const on = inEffect(c, selection[c.name]);
      return on ? [[c.name, { action: 'reuse' as const, ...(on.databaseId ? { database_id: on.databaseId } : {}) }]] : [];
    }),
  );
}

/** The choices drawn as `many`: the ones whose pick needs a database id and a server confirmation. */
export function manyChoices(choices: ExistingChoice[]): ExistingChoice[] {
  return choices.filter((c) => reuseView(c.hint).kind === 'many');
}

/** The choices that are a single reusable database: asked as if reused, to show what "use existing" would add before it is picked. */
export function singleReusable(choices: ExistingChoice[]): ExistingChoice[] {
  return choices.filter((c) => {
    const v = reuseView(c.hint);
    return v.kind === 'single' && v.hint.reusable;
  });
}

/**
 * What the confirming preview (asked WITH the picks) says back: the names it did not adopt, i.e. picks the server no longer stands behind.
 * `databases` is that preview's list; a pick whose row is missing, not adopted or not reusable counts as dropped.
 */
export function droppedPicks(picks: Record<string, unknown>, databases: Array<{ name: string; existing_elsewhere?: ExistingElsewhere }>): string[] {
  return Object.keys(picks).filter((name) => {
    const e = databases.find((d) => d.name === name)?.existing_elsewhere;
    return !(e?.adopted === true && e.reusable === true);
  });
}

/**
 * The line under the picker for the rest: "3 can't be used: The Tool (Estimate is a select here but this pack needs a number), Engineering
 * (Linear), StoryFunnels (Linear). The Linear ones sync from Linear." The server's reasons are whole sentences; a Linear mirror is named
 * once, at the end, and an ordinary reason goes in brackets without its full stop. Empty when everything can be used.
 */
export function cantUseLine(unusable: ReuseCandidate[]): string | null {
  if (unusable.length === 0) return null;
  const short = (c: ReuseCandidate) => (isLinearMirrorReason(c.reason) ? 'synced from Linear' : (c.reason ?? 'it can’t take this pack').trim().replace(/\.$/, ''));
  if (unusable.length === 1) return `${unusable[0]!.space_name} can’t be used: ${short(unusable[0]!)}.`;
  const names = unusable.map((c) => (isLinearMirrorReason(c.reason) ? c.space_name : `${c.space_name} (${short(c)})`)).join(', ');
  return `${unusable.length} can’t be used: ${names}.${unusable.some((c) => isLinearMirrorReason(c.reason)) ? ' The Linear ones sync from Linear.' : ''}`;
}

/** The quiet line when several exist and none can be used: "You have 2 Sprints databases, but both sync from Linear, so this pack makes its own." */
export function noneUsableLine(name: string, unusable: ReuseCandidate[]): string {
  const every = unusable.length > 0 && unusable.every((c) => isLinearMirrorReason(c.reason));
  const why = every ? `${unusable.length === 2 ? 'both' : 'all'} sync from Linear` : 'none can take this pack';
  return `You have ${unusable.length} ${name} databases, but ${why}, so this pack makes its own.`;
}

/**
 * The review's bottom note when something is reused (Dara); null when nothing is, so the caller keeps its own sentence. `labels` are the
 * reused databases as the note names them: "Clients" for the one-candidate row, "Issues (in StoryOS)" for a pick among several.
 */
export function reuseNote(labels: string[]): string | null {
  return labels.length === 0 ? null : `Uses your existing ${andList(labels)} from another space. Everything else is new, and nothing you have is removed.`;
}

/** What `reuseNote` names, in choice order. */
export function reusedLabels(choices: ExistingChoice[], selection: ReuseSelection): string[] {
  return choices.flatMap((c) => {
    const on = inEffect(c, selection[c.name]);
    return on ? [on.label] : [];
  });
}

/**
 * "an Issues database" / "a Sprints database": the article follows the NAME's first SOUND, not its first letter, so it lives in this one
 * helper. A vowel letter takes "an" except where it is sounded like "you"/"wun" (Users, Units, Europe, One-offs); a silent h takes "an"
 * (Hours, Honours); an ALL-CAPS name is read letter by letter ("an SOP", "an FAQ", but "a UI", "a KPI").
 */
export function anArticle(name: string): 'a' | 'an' {
  const n = name.trim();
  if (!n) return 'a';
  const first = n.split(/[\s\-_/]/)[0]!;
  if (first.length >= 2 && /^[A-Z0-9]+s?$/.test(first) && /[A-Z]/.test(first)) return /^[AEFHILMNORSX]/.test(first) ? 'an' : 'a';
  const w = n.toLowerCase();
  if (/^(?:hour|honest|honou?r|heir)/.test(w)) return 'an';
  if (/^(?:one|once|eu|u[bcdfghjklmnpqrstvwxyz][aeiou])/.test(w)) return 'a';
  return /^[aeiou]/.test(w) ? 'an' : 'a';
}

/** `aDatabase('Issues')` -> "an Issues database". */
export function aDatabase(name: string): string {
  return `${anArticle(name)} ${name} database`;
}
