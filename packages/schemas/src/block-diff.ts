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
 * A block's identity for diffing. Real documents always carry a string
 * `id` (see the module comment). A block missing one — old data, or a
 * shape this diff doesn't recognize — gets a positional identity instead,
 * so it still participates in the diff rather than crashing or being
 * silently dropped; it just can't be identity-matched across a move.
 */
function identityOf(block: Block, index: number): string {
  return typeof block.id === 'string' ? block.id : `\0#${index}`;
}

/**
 * Diffs two rich_text (BlockNote block array) values by block identity.
 * Returns one entry per block that was added, removed, or changed content
 * — omitting blocks that are identical (including merely reordered ones).
 */
export function diffBlocks(before: unknown, after: unknown): BlockChange[] {
  const beforeBlocks = toBlockArray(before);
  const afterBlocks = toBlockArray(after);

  const beforeById = new Map<string, Block>();
  beforeBlocks.forEach((b, i) => beforeById.set(identityOf(b, i), b));
  const afterById = new Map<string, Block>();
  afterBlocks.forEach((b, i) => afterById.set(identityOf(b, i), b));

  const changes: BlockChange[] = [];
  const seen = new Set<string>();

  for (const [id, beforeBlock] of beforeById) {
    seen.add(id);
    const afterBlock = afterById.get(id);
    if (afterBlock === undefined) {
      changes.push({ kind: 'removed', blockId: id, from: beforeBlock });
    } else if (JSON.stringify(beforeBlock) !== JSON.stringify(afterBlock)) {
      changes.push({ kind: 'changed', blockId: id, from: beforeBlock, to: afterBlock });
    }
  }
  for (const [id, afterBlock] of afterById) {
    if (!seen.has(id)) {
      changes.push({ kind: 'added', blockId: id, to: afterBlock });
    }
  }
  return changes;
}
