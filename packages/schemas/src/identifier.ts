/**
 * Ticket #1363 — record identifiers: `<PREFIX>-<number>`, e.g. `ISSUE-5201`.
 *
 * A database opts in by carrying an `identifier_prefix`. The identifier is DERIVED (prefix + '-' + the record's public number) and never
 * stored, so it cannot drift from either half. This file is the ONE place the shape is defined: the API validates and parses with it,
 * the MCP tool and the web redirect parse with it, so no surface re-implements "what is an identifier". It imports nothing, because
 * the MCP bundle reaches it (bundle-safety.test.ts: no zod in what the bundle pulls in); the zod schema for the prefix lives in databases.ts.
 */

/** A prefix: an uppercase letter, then 1-9 uppercase letters or digits. The same pattern backs the database CHECK constraint. */
export const IDENTIFIER_PREFIX_PATTERN = '^[A-Z][A-Z0-9]{1,9}$';
export const IDENTIFIER_PREFIX_RE = new RegExp(IDENTIFIER_PREFIX_PATTERN);

/** `records.number` is a Postgres integer. */
const MAX_NUMBER = 2_147_483_647;

/**
 * `ISSUE-5201` (any case; surrounding whitespace ignored) -> `{ prefix: 'ISSUE', number: 5201 }`, or null when the text is not shaped
 * like an identifier. The prefix is returned upper-cased: lookup is case-insensitive, storage is not.
 */
export function parseIdentifier(text: string): { prefix: string; number: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,10})$/.exec(text.trim());
  if (!m) return null;
  const number = Number.parseInt(m[2]!, 10);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER) return null;
  return { prefix: m[1]!.toUpperCase(), number };
}

/** prefix + '-' + number, or null when either half is missing (no prefix, or a record with no number yet). */
export function formatIdentifier(prefix: string | null | undefined, number: number | null | undefined): string | null {
  if (!prefix || number == null) return null;
  return `${prefix}-${number}`;
}
