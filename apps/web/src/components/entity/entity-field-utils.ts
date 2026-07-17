import type { FilterCondition, SortSpec } from '@/components/views/use-view-state';
import type { Field, RecordRow } from '@/components/table-view/use-table-data';

// id renders in the header, title is the page heading — showing them again is
// duplication. The audit fields (MN-126) are NOT hidden outright any more: they
// exist on every database and are now opt-in from the field picker.
export const HIDDEN = new Set(['id', 'title']);
/** System audit fields — read-only, opt-in, sourced from the record row not values (MN-126). */
export const AUDIT_TYPES = new Set(['created_at', 'updated_at', 'created_by']);
export const NOT_INLINE = new Set(['lookup', 'rollup', 'button', 'formula', 'created_at', 'updated_at', 'created_by']);

export type Zone = 'top' | 'sidebar' | 'body';

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
export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}
/** Hidden outright, or flagged hide-when-empty and currently empty. */
export function isHidden(f: Field, record: RecordRow): boolean {
  if (f.config?.['entity_hidden'] === true) return true;
  // Audit fields are available but default-hidden, so a record doesn't sprout three
  // new rows until the user opts in from the picker (MN-126).
  if (AUDIT_TYPES.has(f.type) && f.config?.['entity_hidden'] !== false) return true;
  return f.config?.['hide_when_empty'] === true && isEmptyValue(record.values[f.apiName]);
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
  color_by?: string; // target select field api_name
  /** Target-field api_names shown inline as columns per linked record (MN-206). */
  fields?: string[];
}
