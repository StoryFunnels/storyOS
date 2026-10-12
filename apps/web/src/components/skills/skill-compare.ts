/**
 * #833 / #836 — "will a model pick this one?"
 *
 * A model does not ask whether a skill is good; it asks WHICH of the available
 * skills is the one. So the quality of a `when_to_use` is its distance from its
 * nearest neighbour, and it is authored against those neighbours rather than
 * alone (Otto's ruling on #833, the criterion the design was judged on).
 *
 * THIS IS STATIC AND DELIBERATELY SO: it compares stored strings and runs
 * nothing, so it cannot drift into AC6's territory (StoryOS offers no Run). It
 * is also a LEXICAL heuristic — it finds shared wording, not shared meaning —
 * and the UI says "shared wording" for exactly that reason. A heuristic that
 * claimed to measure semantic similarity would be a confident wrong answer.
 */

/** The discovery budget the design quotes: frontmatter of every skill competes
 * for roughly this much of a reader's context before any instructions load. */
export const DISCOVERY_BUDGET_TOKENS = 5000;

/** At or above this word-overlap the verdict is "too close to call". Calibrated
 * against the two shipped scaffolds that genuinely collide (see the unit test),
 * not picked from the air. */
export const CLOSE_THRESHOLD = 0.2;

// Words that carry no selecting power. Kept short on purpose: this is not a
// linguistics library, only enough to stop "when a the" counting as overlap.
const STOP = new Set(
  (
    'a an the and or but of to in on for with from by at as is are be been it its this that these those ' +
    'when where while who whom what which how not no nor so than then there their them they you your we our ' +
    'someone something anyone into onto over under per via also can may might should would will shall ' +
    'new one any each every rather instead need needs want wants comes come lands land comes'
  ).split(/\s+/),
);

/** A crude suffix stemmer — "replies"/"reply", "drafted"/"drafts"/"draft" meet.
 * Good enough for overlap marking; not a general stemmer. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  return w;
}

export function tokenize(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/** The stems of the words that can actually distinguish one skill from another. */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of tokenize(text)) {
    const lower = word.toLowerCase();
    if (lower.length < 3 || STOP.has(lower)) continue;
    out.add(stem(lower));
  }
  return out;
}

export interface Overlap {
  shared: number;
  /** shared / union, 0 to 1. Penalises a long text for every word it adds. */
  jaccard: number;
  /** shared / the smaller text's size. Does NOT drop when you add unrelated
   * words to one side — which is the point of having it. */
  containment: number;
}

export function overlap(a: string, b: string): Overlap {
  const sa = contentStems(a);
  const sb = contentStems(b);
  if (sa.size === 0 || sb.size === 0) return { shared: 0, jaccard: 0, containment: 0 };
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return { shared, jaccard: shared / (sa.size + sb.size - shared), containment: shared / Math.min(sa.size, sb.size) };
}

/** Containment only counts once at least this many content words are shared:
 * a two-word skill is trivially "contained" in almost anything. */
const MIN_SHARED_FOR_CONTAINMENT = 3;
/** Calibrated on the real shipped scaffolds, not picked: the colliding pair
 * shares 4 content words (containment 0.40; 0.31 once an unrelated sentence is
 * appended), while every unrelated pair shares at most 2 (containment <= 0.15).
 * With the 3-word floor above, 0.25 sits in the empty gap between them. */
export const CLOSE_CONTAINMENT = 0.25;

/**
 * How close two `when_to_use` texts are, 0 to 1. Jaccard alone has a hole: a
 * colliding sentence followed by a long unrelated one reads as "distinct",
 * because the added words inflate the union. A person doing that by accident —
 * or an author padding to escape the warning — would get a false all-clear, so
 * the score is the larger of Jaccard and (guarded) containment.
 */
export function similarity(a: string, b: string): number {
  const o = overlap(a, b);
  return o.shared >= MIN_SHARED_FOR_CONTAINMENT ? Math.max(o.jaccard, o.containment * CLOSE_THRESHOLD / CLOSE_CONTAINMENT) : o.jaccard;
}

export type SegmentKind = 'plain' | 'shared' | 'unique';
export interface Segment {
  text: string;
  kind: SegmentKind;
}

/**
 * Split `text` into runs, marking each content word as `shared` (also in
 * `other`) or — only when `markUnique` — `unique` (a content word `other` does
 * not have: what only THIS skill says). Whitespace and punctuation stay `plain`
 * and every run concatenates back to the original text exactly.
 */
export function markSegments(text: string, other: string, markUnique: boolean): Segment[] {
  const otherStems = contentStems(other);
  const parts = text.split(/([A-Za-z0-9]+)/);
  const segs: Segment[] = [];
  const push = (t: string, kind: SegmentKind) => {
    if (!t) return;
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += t;
    else segs.push({ text: t, kind });
  };
  for (const part of parts) {
    if (/^[A-Za-z0-9]+$/.test(part)) {
      const lower = part.toLowerCase();
      if (lower.length < 3 || STOP.has(lower)) push(part, 'plain');
      else if (otherStems.has(stem(lower))) push(part, 'shared');
      else push(part, markUnique ? 'unique' : 'plain');
    } else {
      push(part, 'plain');
    }
  }
  return segs;
}

export interface RivalSkill {
  id: string;
  name: string;
  when_to_use: string;
}

export interface RivalComparison {
  id: string;
  name: string;
  similarity: number;
  segments: Segment[];
}

export type Verdict =
  | { kind: 'empty' }
  | { kind: 'alone' }
  | { kind: 'distinct'; nearest: string }
  | { kind: 'close'; nearest: string; sharedWords: string[] };

export interface Comparison {
  /** The draft, marked against its single closest rival. */
  mine: Segment[];
  /** Up to `limit` rivals, closest first, each marked against the draft. */
  rivals: RivalComparison[];
  verdict: Verdict;
}

/** The words the draft and a rival both lean on, in the draft's own spelling
 * and order, for the verdict to name rather than gesture at. */
export function sharedWords(draft: string, other: string, max = 4): string[] {
  const otherStems = contentStems(other);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of tokenize(draft)) {
    const lower = word.toLowerCase();
    if (lower.length < 3 || STOP.has(lower)) continue;
    const s = stem(lower);
    if (!otherStems.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(lower);
    if (out.length >= max) break;
  }
  return out;
}

export function compareToRivals(draft: string, rivals: RivalSkill[], limit = 3): Comparison {
  const text = draft.trim();
  if (!text) return { mine: [], rivals: [], verdict: { kind: 'empty' } };
  const ranked = rivals
    .filter((r) => r.when_to_use.trim() !== '')
    .map((r) => ({ r, s: similarity(text, r.when_to_use) }))
    .sort((a, b) => b.s - a.s);
  if (ranked.length === 0) return { mine: markSegments(draft, '', false), rivals: [], verdict: { kind: 'alone' } };
  const top = ranked[0]!;
  const mine = markSegments(draft, top.r.when_to_use, true);
  const shown: RivalComparison[] = ranked.slice(0, limit).map(({ r, s }) => ({
    id: r.id,
    name: r.name,
    similarity: s,
    segments: markSegments(r.when_to_use, text, false),
  }));
  const verdict: Verdict =
    top.s >= CLOSE_THRESHOLD
      ? { kind: 'close', nearest: top.r.name, sharedWords: sharedWords(text, top.r.when_to_use) }
      : { kind: 'distinct', nearest: top.r.name };
  return { mine, rivals: shown, verdict };
}

/** A rough token count: ~4 characters per token. Labelled an estimate wherever
 * it is shown — it is a budget gauge, not a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function skillSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

/**
 * The frontmatter a reader's AI is shown at discovery: what `list_skills`
 * returns per skill. Instructions are NOT in it — they load only on activation,
 * which is why length matters far less there than in these three fields.
 * (`allowed_tools` is deliberately absent: it is being retired from the
 * surface, ticket #833's amended AC2.)
 */
export function discoveryBlock(skill: { name: string; description: string; when_to_use: string }): string {
  return [
    `name: ${skillSlug(skill.name)}`,
    `description: ${skill.description.trim()}`,
    `when-to-use: ${skill.when_to_use.trim()}`,
  ].join('\n');
}
