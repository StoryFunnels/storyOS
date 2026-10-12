/**
 * Block-level diff for rich_text (BlockNote) documents (#595).
 *
 * A rich_text field/document is an array of blocks, each carrying a stable
 * `id` assigned once at creation and preserved across edits and reordering
 * (apps/web's dashboard-view.tsx keys blocks by `block.id`; every stored
 * rich_text fixture carries one — see apps/api/test's `blocknote()` helper).
 * That identity is what lets this tell "the same block, edited" apart from
 * "a different block entirely" without knowing anything about intent.
 *
 * It deliberately does NOT report a "moved" change: a block whose id and
 * content are both unchanged produces no entry, regardless of its position
 * in the array. Position tracking was flagged as an open design question
 * (ticket #595's own thread) — reporting a moved-but-untouched block as a
 * change would answer that question by omission. Matching on id sidesteps
 * it entirely: identity, not position, decides "same block".
 *
 * Self-contained on purpose, same reasoning as markdown.ts: the MCP ships as
 * its own npm package and can't reach into the API's converters. Callers
 * needing content-level rendering of a change do their own thing with
 * `from`/`to` — this only says WHICH blocks differ and how.
 */

interface Block {
  id?: unknown;
  [key: string]: unknown;
}

export type BlockChange =
  | { kind: 'added'; blockId: string; to: unknown }
  | { kind: 'removed'; blockId: string; from: unknown }
  | { kind: 'changed'; blockId: string; from: unknown; to: unknown };

function toBlockArray(value: unknown): Block[] {
  return Array.isArray(value) ? (value as Block[]) : [];
}

/**
 * #840 — JSON with every object's keys sorted, arrays left in order.
 *
 * Comparing `JSON.stringify(a) === JSON.stringify(b)` is a comparison of KEY
 * ORDER as much as of content, and the two sides of a diff do not share one:
 * the stored side was read back from a Postgres jsonb column, which re-sorts
 * object keys (shortest first, then alphabetically), while the new side arrives
 * in whatever order its writer used. A block written through the API or by an
 * agent rarely uses jsonb's order, so EVERY block read as "changed" even when
 * `from` and `to` were identical (five "changed" blocks for a one-line edit —
 * reproduced against the real API before this fix). Content written by the
 * editor escapes it only because BlockNote's own key order happens to match.
 *
 * Arrays keep their order: [a, b] and [b, a] are different content.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined) // JSON.stringify drops these too
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Deep equality that ignores object key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

const hasId = (block: Block): boolean => typeof block.id === 'string';

/**
 * A block's identity for the diff it reports. Real documents carry a string
 * `id`. A block missing one — API- or agent-written content, old data — gets a
 * positional identity instead, so it still participates rather than crashing.
 *
 * #796 — the fallback used a literal NUL byte, which Postgres's jsonb rejects
 * outright (22P05) once the diff is written into activity_events.payload; a
 * printable sentinel that merely must not collide with a real id is strictly
 * better.
 */
function identityOf(block: Block, index: number): string {
  return hasId(block) ? (block.id as string) : `__no-id__#${index}`;
}

function omitId(block: Block): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...block };
  delete rest.id;
  return rest;
}

/**
 * Diffs two rich_text (BlockNote block array) values.
 *
 * THE MATCHING RULE (#840), in order — a missing id never IMPLIES a change:
 *   1. Blocks with a string `id` that appears on both sides are the same block;
 *      it is reported only if its content differs (key order ignored).
 *   2. Among the blocks still unmatched, a block with NO id matches an
 *      unmatched block on the other side whose content is identical once `id`
 *      is ignored — the same block written without an id. Reported as nothing.
 *      (Two blocks that BOTH carry different ids are never content-matched:
 *      those are genuinely different identities.)
 *   3. Remaining id-less blocks pair up in order with the remaining blocks on
 *      the other side — "this slot was edited" — and are reported as changed.
 *   4. Whatever is left is removed (before) or added (after).
 *
 * Reordering never reports anything: identity, not position, decides step 1.
 */
export function diffBlocks(before: unknown, after: unknown): BlockChange[] {
  const B = toBlockArray(before);
  const A = toBlockArray(after);

  // pair[i] = index in A matched to B[i]; `identical` marks pairs that need no entry.
  const pair = new Map<number, number>();
  const identical = new Set<number>();
  const takenA = new Set<number>();

  // 1. by id.
  const afterById = new Map<string, number>();
  A.forEach((b, j) => {
    if (hasId(b) && !afterById.has(b.id as string)) afterById.set(b.id as string, j);
  });
  B.forEach((b, i) => {
    if (!hasId(b)) return;
    const j = afterById.get(b.id as string);
    if (j === undefined || takenA.has(j)) return;
    pair.set(i, j);
    takenA.add(j);
    if (jsonEqual(b, A[j])) identical.add(i);
  });

  // 2. identical content, ignoring id, where at least one side has none.
  for (let i = 0; i < B.length; i++) {
    if (pair.has(i)) continue;
    const key = canonicalJson(omitId(B[i]!));
    for (let j = 0; j < A.length; j++) {
      if (takenA.has(j)) continue;
      if (hasId(B[i]!) && hasId(A[j]!)) continue;
      if (canonicalJson(omitId(A[j]!)) !== key) continue;
      pair.set(i, j);
      identical.add(i);
      takenA.add(j);
      break;
    }
  }

  // 3. positional pairing of what is left, where at least one side has no id.
  for (let i = 0; i < B.length; i++) {
    if (pair.has(i)) continue;
    for (let j = 0; j < A.length; j++) {
      if (takenA.has(j)) continue;
      if (hasId(B[i]!) && hasId(A[j]!)) continue;
      pair.set(i, j);
      takenA.add(j);
      break;
    }
  }

  // 4. report.
  const changes: BlockChange[] = [];
  B.forEach((b, i) => {
    const j = pair.get(i);
    if (j === undefined) {
      changes.push({ kind: 'removed', blockId: identityOf(b, i), from: b });
    } else if (!identical.has(i)) {
      const blockId = hasId(b) ? (b.id as string) : hasId(A[j]!) ? (A[j]!.id as string) : identityOf(b, i);
      changes.push({ kind: 'changed', blockId, from: b, to: A[j] });
    }
  });
  A.forEach((b, j) => {
    if (!takenA.has(j)) changes.push({ kind: 'added', blockId: identityOf(b, j), to: b });
  });
  return changes;
}
