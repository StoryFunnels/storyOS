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

/**
 * A record IDENTIFIER (ticket #1363/#1368): `<PREFIX>-<n>`, where PREFIX is a database's identifier prefix and n its record number.
 *
 * In a BRANCH it may sit after a `type/` or `user/` segment or open the name, in either case (`feat/issue-5201`, `fix/ISSUE-5201-x`,
 * `dana/sp-77-widen`): branches are lower-cased by habit. In PROSE (title, body) only the upper-case form counts, because
 * `issue-5` in a sentence is just words while `ISSUE-5201` is what trackers print. The match is deliberately generic about the prefix
 * and the CALLER narrows it to the link database's own prefix, so this file stays pure and a look-alike (`CVE-2024-1234`) is dropped
 * there, not guessed at here. The number is capped like `parseIdentifier` caps it.
 */
const BRANCH_IDENTIFIER_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,10})(?![A-Za-z0-9])/g;
const TEXT_IDENTIFIER_RE = /(?<![A-Za-z0-9/.-])([A-Z][A-Z0-9]{1,9})-(\d{1,10})(?![A-Za-z0-9])/g;
const MAX_RECORD_NUMBER = 2_147_483_647;

export interface IdentifierRef {
  prefix: string;
  number: number;
}

/** Branch first (strongest signal), then the title, then the body. Upper-cased prefix, deduped, ordered. */
export function extractIdentifiers(input: {
  branch?: string | null;
  title?: string | null;
  body?: string | null;
}): IdentifierRef[] {
  const out: IdentifierRef[] = [];
  const add = (prefix: string, digits: string) => {
    const number = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_RECORD_NUMBER) return;
    const p = prefix.toUpperCase();
    if (!out.some((r) => r.prefix === p && r.number === number)) out.push({ prefix: p, number });
  };
  for (const m of (input.branch ?? '').matchAll(BRANCH_IDENTIFIER_RE)) add(m[1]!, m[2]!);
  for (const text of [input.title ?? '', input.body ?? '']) {
    for (const m of text.matchAll(TEXT_IDENTIFIER_RE)) add(m[1]!, m[2]!);
  }
  return out;
}

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
