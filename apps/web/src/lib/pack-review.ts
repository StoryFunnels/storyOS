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

export interface PackRelation {
  from: string;
  to: string;
  cardinality: 'one_to_many' | 'many_to_many';
  from_field?: string;
  to_field?: string;
}

/** What the API's `existing_elsewhere` says (packs #1156). Mirrors `packPreviewItemSchema`; kept structural so tests need no schema build. */
export interface ExistingElsewhere {
  database_id?: string;
  space_name?: string;
  adopted: boolean;
  reusable: boolean;
  reason?: string;
}

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
  heading: (name: string) => `You already have a ${name} database in another space.`,
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

/** What is selected: only a database the person explicitly chose to reuse is `true`. The DEFAULT, for every database, is "create a new one". */
export type ReuseSelection = Record<string, boolean>;

/** The names whose "use existing" is in effect: chosen AND reusable. A disabled card can never be in effect, whatever state says. */
export function reusedNames(choices: ExistingChoice[], selection: ReuseSelection): string[] {
  return choices.filter((c) => selection[c.name] === true && c.hint.reusable).map((c) => c.name);
}

/** The `resolutions` entries for the install (and the what-if preview): `{ Clients: { action: 'reuse' } }`, only for what was chosen. */
export function reuseResolutions(choices: ExistingChoice[], selection: ReuseSelection): Record<string, { action: 'reuse' }> {
  return Object.fromEntries(reusedNames(choices, selection).map((n) => [n, { action: 'reuse' as const }]));
}

/** The review's bottom note when something is reused (Dara); null when nothing is, so the caller keeps its own sentence. */
export function reuseNote(names: string[]): string | null {
  return names.length === 0 ? null : `Uses your existing ${andList(names)} from another space. Everything else is new, and nothing you have is removed.`;
}
