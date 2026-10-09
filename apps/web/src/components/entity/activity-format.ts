/**
 * How a value in an Activity line is shown. Third pass over this one formatter
 * (#796, #806, #829) — each fixed the case in front of it and wrote down the gap it
 * was leaving. This pass closes the class, not the instance: **no value reaches
 * `String()` as an object.**
 *
 * What a stored value can be, by field type, and what it renders:
 *   text / url / email / color / date ... the string as stored (formatting dates here
 *                                          would make history the one surface that does;
 *                                          #335 refused that)
 *   number / checkbox ................... String(value), a primitive
 *   select / multi_select / workflow .... labels (the API already resolved option ids)
 *   user / created_by / updated_by ...... the member's NAME; a removed member renders
 *                                          REMOVED_MEMBER_LABEL (#806), never the id
 *   rich_text ........................... an ARRAY OF BLOCK OBJECTS: its plain text,
 *                                          truncated (#829) — never the objects
 *   attachment .......................... file names
 *   lookup / rollup / formula / button / ai   computed, not normally diffed; a primitive
 *                                          renders as is, an object as the placeholder
 *   anything else, any other object ..... OBJECT_PLACEHOLDER
 *
 * Rich-text CHANGES are usually rendered as a block diff instead (`resolveBlockChanges`
 * + `blockLines`); this formatter is the fallback when a diff is not available, and it
 * must still be readable. An id with no matching member resolves to the SAME fallback
 * the record-history panel uses.
 *
 * `activity-format.unit.test.ts` pins the class: every field type crossed with every
 * object-shaped value, none may produce "[object Object]".
 */
import { diffBlocks } from '@storyos/schemas/block-diff';
import type { BlockChange } from '@storyos/schemas/block-diff';
import { blockPlainText } from './entity-field-utils';

export const USER_ID_FIELD_TYPES: ReadonlySet<string> = new Set(['user', 'created_by', 'updated_by']);

export const REMOVED_MEMBER_LABEL = '(removed member)';

/** Shown for an object-valued value this formatter has no renderer for. */
export const OBJECT_PLACEHOLDER = '(complex value)';
/** Shown for rich text that has blocks but no text in them (an image, a divider). */
export const NO_TEXT_PLACEHOLDER = '(no text)';
const MAX_TEXT = 140;

export function truncateText(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A BlockNote block: has a string `type` and a `content` or `children` of its own. */
function isBlockLike(v: unknown): boolean {
  return isObject(v) && typeof v.type === 'string' && ('content' in v || 'children' in v);
}

/** A block's text, or null when it has none (blockPlainText's own sentinel). */
function blockText(block: unknown): string | null {
  const text = blockPlainText(block);
  return text === '(empty block)' ? null : text;
}

function describeBlocks(blocks: unknown[]): string {
  const texts = blocks.map(blockText).filter((t): t is string => t !== null);
  return texts.length > 0 ? truncateText(texts.join(' / ')) : NO_TEXT_PLACEHOLDER;
}

function describeObject(value: Record<string, unknown>): string {
  if (isBlockLike(value)) return truncateText(blockText(value) ?? NO_TEXT_PLACEHOLDER);
  // An attachment is a file object; its name is what a person recognises.
  if (typeof value.name === 'string' && value.name) return value.name;
  return OBJECT_PLACEHOLDER;
}

export function formatActivityValue(
  value: unknown,
  fieldType: string | undefined,
  memberName: (id: string) => string | undefined,
): string {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'empty';
    if (fieldType === 'rich_text' || value.some(isBlockLike)) return describeBlocks(value);
    return value.map((v) => formatActivityValue(v, fieldType, memberName)).join(', ');
  }
  if (isObject(value)) return describeObject(value);
  if (fieldType && USER_ID_FIELD_TYPES.has(fieldType) && typeof value === 'string') {
    return memberName(value) ?? REMOVED_MEMBER_LABEL;
  }
  // Only primitives (string / number / boolean / bigint / symbol-free) can be here.
  return String(value);
}

/**
 * The block-level changes for a rich_text change, or undefined when this is not one.
 *
 * ALWAYS recomputed from the stored `from` / `to` (which are the full block arrays)
 * rather than trusting the `blocks` stored beside them (#840). Rows written before
 * #796 carry no `blocks` at all, and rows written before #840 carry blocks the old
 * `diffBlocks` got wrong: every block of API- or agent-written content was stored as
 * "changed" because the diff compared JSON key order, and history rows cannot be
 * repaired after the fact. Recomputing with the current `diffBlocks` makes an old row
 * render exactly like a fresh edit, and the stored `blocks` only matter for a value
 * that is not block-shaped at all.
 */
export function resolveBlockChanges(
  change: { from: unknown; to: unknown; blocks?: BlockChange[] },
  fieldType: string | undefined,
): BlockChange[] | undefined {
  const blockish = (v: unknown) => Array.isArray(v) && v.some(isBlockLike);
  if (fieldType === 'rich_text' || blockish(change.from) || blockish(change.to)) {
    return diffBlocks(change.from, change.to);
  }
  return change.blocks;
}

export type BlockLine =
  | { kind: 'added'; text: string }
  | { kind: 'removed'; text: string }
  | { kind: 'changed'; from: string; to: string }
  /** Blocks whose TEXT is identical before and after: only formatting / props moved. */
  | { kind: 'formatting'; count: number };

/**
 * What to print for a list of block changes. Blocks whose plain text did not change
 * are collapsed into ONE formatting line: the first save after content was written by
 * the API or an agent makes the editor normalise every block's props, which the diff
 * correctly reports as a change on every block — fourteen "X → X" pairs say nothing a
 * person can read, and "formatting changed in 14 blocks" says exactly what happened.
 * An empty diff is one honest line, not a blank.
 */
export function blockLines(blocks: BlockChange[]): BlockLine[] {
  const lines: BlockLine[] = [];
  let formatting = 0;
  for (const b of blocks) {
    if (b.kind === 'added') lines.push({ kind: 'added', text: truncateText(blockText(b.to) ?? NO_TEXT_PLACEHOLDER) });
    else if (b.kind === 'removed') lines.push({ kind: 'removed', text: truncateText(blockText(b.from) ?? NO_TEXT_PLACEHOLDER) });
    else {
      const from = blockText(b.from);
      const to = blockText(b.to);
      if (from === to) formatting += 1;
      else lines.push({ kind: 'changed', from: truncateText(from ?? NO_TEXT_PLACEHOLDER), to: truncateText(to ?? NO_TEXT_PLACEHOLDER) });
    }
  }
  if (formatting > 0) lines.push({ kind: 'formatting', count: formatting });
  return lines;
}
