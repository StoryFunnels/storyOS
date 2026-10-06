'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { FilterCondition, NullsPlacement, SortSpec } from '@/components/views/use-view-state';
import type { Field, RecordRow } from '@/components/table-view/use-table-data';

/**
 * #677 (Gap 2) — "human-readable, not raw JSON" for a BlockNote block, the
 * document-diff sibling of the field-diff `*_display` strings the API
 * already computes for `record_field_changes`. Mirrors
 * `documents.service.ts`'s own `extractText` (same recursive text-node walk)
 * applied to ONE block instead of a whole document — that helper is
 * API-internal (used for search-index text), so this is the client-side
 * copy of the same shape rather than a new algorithm.
 *
 * #796 — moved here from record-history.tsx so panels.tsx's ActivityPanel
 * can share it rather than writing a second implementation.
 */
export function blockPlainText(block: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.text === 'string') parts.push(obj.text);
      Object.values(obj).forEach(walk);
    }
  };
  walk(block);
  const text = parts.join(' ').trim();
  return text || '(empty block)';
}

// id renders in the header, title is the page heading — showing them again is
// duplication. The audit fields (MN-126) are NOT hidden outright any more: they
// exist on every database and are now opt-in from the field picker.
export const HIDDEN = new Set(['id', 'title']);
/** System audit fields — read-only, opt-in, sourced from the record row not values (MN-126). */
export const AUDIT_TYPES = new Set(['created_at', 'updated_at', 'created_by']);
// #776 — `ai` (#571: a field computed by an LLM call) was added after this set
// was written and missed it: it's computed, never typed, same as formula/rollup/
// lookup, but rendered with an ordinary click-to-edit affordance that would
// error server-side on any write attempt (record-values.ts's coerce() has no
// case for it).
export const NOT_INLINE = new Set(['lookup', 'rollup', 'button', 'formula', 'ai', 'created_at', 'updated_at', 'created_by']);

/**
 * #780 — the design artifact's `.computed` badge: a monospace type-name tag
 * after every computed field's VALUE ("COMPUTED fields are not editable and
 * must not pretend to be" — the artifact's own CSS comment). Derived from
 * NOT_INLINE/AUDIT_TYPES rather than re-enumerating field types, so this
 * can't drift from the sets that already gate editability — the exact
 * failure shape CLAUDE.md's collision-check section warns a hand-maintained
 * list eventually suffers. `color` and `id` visually sit in the artifact's
 * "Computed" field-GROUP but are editable (color) or hidden entirely (id,
 * via HIDDEN) — neither is in NOT_INLINE, so neither gets a badge, matching
 * the artifact's own data (its `color` row carries no badge).
 */
export function computedBadgeLabel(type: string): string | null {
  if (!NOT_INLINE.has(type)) return null;
  // #811 — a button is not DERIVED: the badge's job is "this value is computed,
  // you cannot type into it", and a button holds no value; it already says what
  // it does ("Mark as Done"). Printing its internal type string beside it reads
  // as debug output. The badge is reserved for types where derivation is the point.
  if (type === 'button') return null;
  return AUDIT_TYPES.has(type) ? 'system' : type;
}

export type Zone = 'top' | 'sidebar' | 'body';

/** #780 — the four collapsible field-group headings on the record page's
 * unified field area (Details/Links/Computed/System), replacing the old
 * top/sidebar zone split now that field zoning is hidden. Matches the
 * design artifact's own grouping exactly (its `FIELDS` array groups the
 * same 25 field types this way) rather than inventing a new taxonomy. */
export type FieldGroup = 'Details' | 'Links' | 'Computed' | 'System';
const FIELD_GROUP: Record<string, FieldGroup> = {
  title: 'Details',
  text: 'Details',
  number: 'Details',
  checkbox: 'Details',
  date: 'Details',
  select: 'Details',
  multi_select: 'Details',
  workflow: 'Details',
  user: 'Details',
  relation: 'Links',
  url: 'Links',
  email: 'Links',
  attachment: 'Links',
  formula: 'Computed',
  rollup: 'Computed',
  lookup: 'Computed',
  ai: 'Computed',
  button: 'Computed',
  color: 'Computed',
  id: 'Computed',
  created_by: 'System',
  created_at: 'System',
  updated_at: 'System',
};
/** Falls back to 'Details' for any type this map doesn't (yet) name — a new
 * field type should be visible somewhere rather than silently unlisted. */
export function fieldGroup(f: Field): FieldGroup {
  return FIELD_GROUP[f.type] ?? 'Details';
}

/** A to-many relation is a collection — it belongs in the body as a list, never the top/sidebar. */
export function isCollection(f: Field): boolean {
  return f.type === 'relation' && (f.relation?.cardinality === 'many_to_many' || f.relation?.side === 'b');
}
export function defaultZone(f: Field): Zone {
  if (f.type === 'rich_text' || isCollection(f)) return 'body';
  return 'sidebar'; // scalars + single references
}
/**
 * Which zones a field shows in (MN-077). A movable field can live in several
 * zones at once (e.g. sidebar AND top). Collections & rich text are body-locked.
 * Reads `entity_zones` (array); falls back to the legacy single `entity_zone`,
 * then the type default.
 */
export function zonesOf(f: Field): Zone[] {
  if (f.type === 'rich_text' || isCollection(f)) return ['body'];
  const zs = f.config?.['entity_zones'];
  if (Array.isArray(zs)) {
    const valid = zs.filter((z): z is Zone => z === 'top' || z === 'sidebar' || z === 'body');
    if (valid.length) return valid;
  }
  const legacy = f.config?.['entity_zone'];
  if (legacy === 'top' || legacy === 'sidebar' || legacy === 'body') return [legacy];
  return [defaultZone(f)];
}
export function orderKey(f: Field, apiIndex: number): number {
  const explicit = f.config?.['entity_order'];
  return typeof explicit === 'number' ? explicit : apiIndex;
}

/**
 * Does this record layout carry its OWN order, or is it still following the
 * database? (#414)
 *
 * `orderKey` above falls back to the field's API position until something writes
 * `entity_order`. That fallback is a good default and it stays — but until this
 * ticket it was also invisible. Dragging one property in a record forked the two
 * orders permanently, with nothing on screen saying so and no way back. UAT hit
 * it exactly that way: grid `Won, Amount, Stage, Owner, Close Date` against
 * record `Close Date, Won, Amount, Stage, Owner`, both persisted, silently
 * disagreeing.
 *
 * The founder chose (a) — keep two orders, but say so and offer a way back. This
 * predicate is the "say so" half and `resetOrderPlan` below is the way back.
 *
 * Note the scope: `entity_order` is field config, so this is per-DATABASE, not
 * per-record and not per-person. Every record of the database shows the same
 * arrangement, and clearing it clears it for everyone — which is why the notice
 * says "this database" rather than "this record".
 *
 * The description takes part in the same integer space (#310) without being a
 * field, so its order counts too or "follow the database order" would leave the
 * description parked where a drag put it.
 */
export function hasOwnRecordOrder(fields: Field[], descriptionOrder?: number | null): boolean {
  if (typeof descriptionOrder === 'number') return true;
  return fields.some((f) => typeof f.config?.['entity_order'] === 'number');
}

/**
 * What "follow the database order" has to clear (#414 AC2).
 *
 * Returned as a plan rather than executed here so the decision is testable
 * without a DOM or a mutation, and so the caller can see it touches the
 * description too.
 *
 * Fields are cleared with `entity_order: null`, not by removing the key: the
 * field-config PATCH is a shallow MERGE server-side, so an omitted key keeps its
 * stored value and only an explicit null overwrites it. `orderKey` tests
 * `typeof === 'number'`, so null reads as unset and the API position takes over
 * again — which is the whole point.
 */
export function resetOrderPlan(
  fields: Field[],
  descriptionOrder?: number | null,
): { fieldIds: string[]; clearDescription: boolean } {
  return {
    fieldIds: fields.filter((f) => typeof f.config?.['entity_order'] === 'number').map((f) => f.id),
    clearDescription: typeof descriptionOrder === 'number',
  };
}
export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}
/**
 * Does this field disappear when it has no value? The explicit choice wins —
 * `true` hides it, `false` is "Always show (even empty)" — and only a field that
 * NEVER made the choice falls back to a default.
 *
 * #783 — the default is per KIND, in code, deliberately not written onto rows:
 * a COLLECTION (a many-to-many, or the many side of a one-to-many) is a headed,
 * bordered block, and an empty one is chrome saying nothing — measured as four of
 * them opening both of the common record shapes. A scalar row names itself in a
 * scannable list, so it keeps showing. A default lives here so a deploy can undo
 * it; a data change would have written one into every relation field in every
 * workspace to express something that is not a fact about their data.
 *
 * The control and the hidden flyout both read THIS, so what the menu offers is
 * what the record does.
 */
export function hidesWhenEmpty(f: Field): boolean {
  const explicit = f.config?.['hide_when_empty'];
  if (typeof explicit === 'boolean') return explicit;
  return isCollection(f);
}
/** Hidden outright, or flagged hide-when-empty and currently empty. */
export function isHidden(f: Field, record: RecordRow): boolean {
  if (f.config?.['entity_hidden'] === true) return true;
  // Audit fields are available but default-hidden, so a record doesn't sprout three
  // new rows until the user opts in from the picker (MN-126).
  if (AUDIT_TYPES.has(f.type) && f.config?.['entity_hidden'] !== false) return true;
  return hidesWhenEmpty(f) && isEmptyValue(record.values[f.apiName]);
}
/** Audit fields live on the record row, not in `values` (MN-126). */
export function auditValue(f: Field, record: RecordRow): unknown {
  if (f.type === 'created_by') return record.created_by;
  if (f.type === 'created_at') return record.created_at;
  if (f.type === 'updated_at') return record.updated_at;
  return undefined;
}

export interface VP {
  ws: string;
  db: string;
  rec: string;
  record: RecordRow;
  members: Array<{ id: string; name: string; image?: string | null }>;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
  readOnly: boolean;
  schemaEditable: boolean;
  onToggleZone: (field: Field, zone: Zone) => void;
  onCommit: (field: Field, value: unknown) => void;
}

export interface CollectionView {
  filters?: { and: FilterCondition[] };
  sorts?: SortSpec[];
  /** Whole-sort empty-values placement (MN-252) — same as ViewConfig.sorts_nulls. */
  sorts_nulls?: NullsPlacement;
  color_by?: string; // target select field api_name
  /** Target-field api_names shown inline as columns per linked record (MN-206). */
  fields?: string[];
}

/**
 * #736 — the current viewer's personal override for one embedded relation
 * collection, mirroring `usePersonalFilter` (#259/use-view-state.ts) exactly:
 * `null` means "no override" (the COMMON case), never `undefined` — react-query
 * rejects an undefined queryFn result outright, so the endpoint answers
 * `{"config": null}` and this hands that back as `null`, not the field's own
 * shared default (collection-section.tsx layers the default in itself).
 */
export function useCollectionViewOverride(ws: string, db: string, fieldId: string | undefined) {
  return useQuery({
    queryKey: ['collection-view-override', ws, db, fieldId],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/personal-collection-view',
        { params: { path: { ws, db, field: fieldId! } } },
      );
      if (error) throw error;
      return (data as unknown as { config: CollectionView | null }).config ?? null;
    },
    enabled: Boolean(fieldId),
  });
}

/** Sets (or replaces) the current viewer's personal override for one embedded
 * collection — never writes to the field's own shared config. */
export function useSetCollectionViewOverride(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fieldId, config }: { fieldId: string; config: CollectionView }) => {
      const { data, error } = await api.PUT(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/personal-collection-view',
        { params: { path: { ws, db, field: fieldId } }, body: config as never },
      );
      if (error) throw error;
      return (data as unknown as { config: CollectionView | null }).config ?? null;
    },
    onSuccess: (config, { fieldId }) =>
      qc.setQueryData(['collection-view-override', ws, db, fieldId], config),
    onError: () => toast.error('Could not save your personal filter'),
  });
}

/** Clears the current viewer's personal override for one embedded collection,
 * falling back to the field's own shared default. */
export function useClearCollectionViewOverride(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fieldId: string) => {
      const { error } = await api.DELETE(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/personal-collection-view',
        { params: { path: { ws, db, field: fieldId } } },
      );
      if (error) throw error;
    },
    onSuccess: (_void, fieldId) =>
      qc.setQueryData(['collection-view-override', ws, db, fieldId], null),
    onError: () => toast.error('Could not clear your personal filter'),
  });
}

/**
 * #813 — is this rich-text value EMPTY? BlockNote can hand back `[]`, `null`, or
 * the single empty paragraph it creates for a blank document, and all three mean
 * "nothing written". A block with text, a non-paragraph block (a divider, an
 * image, a list item), or any child block is content.
 */
export function isEmptyBlocks(value: unknown): boolean {
  if (value == null) return true;
  if (!Array.isArray(value)) return false;
  return value.every((b) => {
    if (!b || typeof b !== 'object') return true;
    const block = b as { type?: string; content?: unknown; children?: unknown };
    if (block.type !== 'paragraph') return false;
    if (Array.isArray(block.children) && block.children.length > 0) return false;
    if (typeof block.content === 'string') return block.content.trim() === '';
    if (!Array.isArray(block.content)) return true;
    return block.content.every((c) => {
      const run = c as { type?: string; text?: unknown };
      return run?.type === 'text' && typeof run.text === 'string' && run.text.trim() === '';
    });
  });
}
