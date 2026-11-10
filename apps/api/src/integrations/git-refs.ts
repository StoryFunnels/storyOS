/**
 * Git <-> record references (ticket #1219). Pure: no DB, no I/O.
 *
 * Two directions of ONE convention:
 *  - `branchNameFor` DERIVES the branch name an issue should use. It is never
 *    stored, so it cannot drift from the title; the record NUMBER is the stable
 *    part, the slug is cosmetic.
 *  - `extractRecordNumbers` reads numbers back out of a PR's branch/title/body.
 *
 * The matcher keys on the NUMBER only (never the slug), and only on forms that
 * cannot be mistaken for something else. A bare `#1234` is ambiguous (PR numbers
 * and ticket numbers share the range and PR numbers collide across repos), so it
 * is never a match; "ticket #N" / "Issue #N" is the repo's own convention.
 */

/** The lane prefixes from CLAUDE.md / docs/architecture/parallel-work.md. */
export const BRANCH_LANES = ['docs', 'mcp', 'api', 'web', 'fix'] as const;
export type BranchLane = (typeof BRANCH_LANES)[number];

const SLUG_MAX = 48;

export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= SLUG_MAX) return base;
  // Cut at a word boundary when one exists past the midpoint, never mid-word.
  const cut = base.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > SLUG_MAX / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

export function branchNameFor(input: { number: number; title: string; lane?: BranchLane }): string {
  const slug = slugify(input.title);
  const tail = slug ? `${input.number}-${slug}` : String(input.number);
  return input.lane ? `${input.lane}/${tail}` : tail;
}

/** `<lane>/<n>-slug` or `<lane>/<n>`: the convention branchNameFor emits. */
const LANE_BRANCH_RE = new RegExp(`^(?:${BRANCH_LANES.join('|')})/(\\d+)(?:-|$)`);

/**
 * "ticket #N" / "tickets #N" / "issue #N" / "issues #N", case-insensitive. The
 * keyword is required: a bare `#N` never matches. The lookbehind keeps
 * `owner/repo#12`-style cross-repo references and `prefix-ticket #5` words out.
 */
const MENTION_RE = /(?<![\w/-])(?:ticket|issue)s?\s+#(\d{1,9})(?!\d)/gi;

/** Branch first (strongest signal), then mentions in title, then body. Deduped, ordered. */
export function extractRecordNumbers(input: {
  branch?: string | null;
  title?: string | null;
  body?: string | null;
}): number[] {
  const out: number[] = [];
  const add = (n: number) => {
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  };
  const lane = (input.branch ?? '').match(LANE_BRANCH_RE);
  if (lane) add(Number(lane[1]));
  for (const text of [input.title ?? '', input.body ?? '']) {
    for (const m of text.matchAll(MENTION_RE)) add(Number(m[1]));
  }
  return out;
}
