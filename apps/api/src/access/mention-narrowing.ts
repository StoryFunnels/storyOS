/**
 * #857 — a record-mention chip inside rich text carries the mentioned record's id and its
 * title at mention time. A record-scoped guest who can read the MENTIONING record would
 * receive that chip verbatim, including a record they cannot read. The ratified rule (#473)
 * is absolute: an unreadable record is absent from every response body — no chip, no id, no
 * title, no count.
 *
 * This file is the pure half: find the record mentions in an arbitrary value, and replace the
 * unreadable ones with ONE fixed placeholder. `MentionNarrowingInterceptor` is the only
 * caller and the only place rich text leaves the server for a restricted caller. Do not call
 * these from an endpoint: that is the per-endpoint copy this exists to prevent.
 *
 * The placeholder is byte-identical for every redacted mention. A placeholder that varied
 * (by type, database or length) would itself be a signal about what it replaced.
 */
export const REDACTED_MENTION_TEXT = '[restricted]';

type Json = unknown;

const isPlain = (v: Json): v is Record<string, Json> =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/** BlockNote inline node: { type: 'mention', props: { kind: 'record', id } }. */
function blockNoteRecordId(node: Record<string, Json>): string | null {
  if (node.type !== 'mention' || !isPlain(node.props)) return null;
  const { kind, id } = node.props;
  return kind === 'record' && typeof id === 'string' && id ? id : null;
}

/** Legacy comment segment (#140): { type: 'record', record_id }. */
function legacySegmentRecordId(node: Record<string, Json>): string | null {
  return node.type === 'record' && typeof node.record_id === 'string' && node.record_id
    ? node.record_id
    : null;
}

const mentionedRecordId = (node: Record<string, Json>): string | null =>
  blockNoteRecordId(node) ?? legacySegmentRecordId(node);

/** Every record id a record-mention node anywhere inside `value` points at. */
export function collectMentionedRecordIds(value: Json, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectMentionedRecordIds(v, into);
  } else if (isPlain(value)) {
    const id = mentionedRecordId(value);
    if (id) into.add(id);
    for (const v of Object.values(value)) collectMentionedRecordIds(v, into);
  }
  return into;
}

/**
 * A copy of `value` with every record mention whose target is NOT in `readable` replaced by
 * the placeholder. Never mutates (stored content is not rewritten); values that are not
 * plain objects/arrays (Dates, Buffers, streams) pass through untouched.
 */
export function narrowMentions(value: Json, readable: ReadonlySet<string>): Json {
  if (Array.isArray(value)) return value.map((v) => narrowMentions(v, readable));
  if (!isPlain(value)) return value;
  const id = mentionedRecordId(value);
  if (id && !readable.has(id)) return { type: 'text', text: REDACTED_MENTION_TEXT, styles: {} };
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value)) out[k] = narrowMentions(v, readable);
  return out;
}

/**
 * What the person SHARING a record is told. The redaction is deliberate and not configurable,
 * but it is invisible to the one person who could otherwise be surprised by it: the text they
 * wrote reads differently to the guest than it does to them.
 */
export const RECORD_SHARE_NOTICE =
  `Record-scoped guests see only what they were granted. Any mention of a record they cannot read ` +
  `(in this record's fields, document or comments) appears to them as "${REDACTED_MENTION_TEXT}". ` +
  `Nothing is changed in your content; it reads differently only to them. Grant access to the ` +
  `mentioned record too if they should see it.`;
