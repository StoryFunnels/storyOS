/**
 * #764 — the shared rewrite core for migrate-number-field-refs.ts and
 * scan-number-field-refs.ts. `number` (deprecated, #743) and `id` are two
 * api_names that resolve identically (both alias `records.number`, see
 * SYSTEM_FIELDS' own comment), so a stored reference to `number` can always
 * be rewritten to `id` with no value change — a rename, not a migration in
 * the data sense.
 *
 * Deliberately more exhaustive than #764's own AC1 wording ("filter/sort
 * clauses"): AC2's actual bar is a QUERY proving zero stored configs still
 * reference `number`, so every place a view config can name a field by
 * api_name is covered here — not just the two AC1 names. A dashboard tile's
 * `field_api_name` or a form field's `relation_filter` referencing `number`
 * would otherwise survive the migration and still trip the AC2 count.
 *
 * Two distinct spellings are involved, never conflated:
 *   - api_name `'number'` — how filters/sorts/dashboard tiles & widgets/
 *     summary widgets/relation_filter reference the field (rewritten to `'id'`).
 *   - the synthetic field id `__sys_number` (systemFieldId('number')) — the
 *     ONE non-uuid entry `hidden_field_ids` accepts (rewritten to `__sys_id`).
 * Rewriting the wrong one in the wrong place is a no-op at best (the schema
 * validators reject a stray `__sys_number` in a filter, and a bare `'number'`
 * in hidden_field_ids was never valid either), so each is handled only where
 * it can actually appear.
 */
import type { FilterNode } from '@storyos/schemas';
import { systemFieldId } from '@storyos/schemas';

const OLD_API_NAME = 'number';
const NEW_API_NAME = 'id';
const OLD_SYSTEM_ID = systemFieldId(OLD_API_NAME);
const NEW_SYSTEM_ID = systemFieldId(NEW_API_NAME);

/** Loose shapes mirroring the relevant slices of packages/schemas/src/views.ts —
 * kept local and untyped-by-zod deliberately: this reads/writes the raw `config`
 * jsonb column, which may hold rows saved by an older schema version. */
interface RawTile {
  field_api_name?: unknown;
  filter?: unknown;
  [key: string]: unknown;
}
interface RawWidget {
  group_by_field_api_name?: unknown;
  measure?: { field_api_name?: unknown; [key: string]: unknown };
  filter?: unknown;
  [key: string]: unknown;
}
interface RawFormField {
  relation_filter?: unknown;
  [key: string]: unknown;
}
interface RawViewConfig {
  filters?: unknown;
  sorts?: unknown;
  hidden_field_ids?: unknown;
  dashboard_tiles?: unknown;
  dashboard_widgets?: unknown;
  summary_widgets?: unknown;
  form?: { fields?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True if `node` (a raw, possibly-malformed FilterNode) references OLD_API_NAME
 * anywhere in its tree. Mirrors query-compiler.ts's filterReferencedFields walk,
 * but tolerant of shapes an older/foreign client may have saved. */
function filterReferencesOldName(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if (Array.isArray(node['and'])) return (node['and'] as unknown[]).some(filterReferencesOldName);
  if (Array.isArray(node['or'])) return (node['or'] as unknown[]).some(filterReferencesOldName);
  return node['field'] === OLD_API_NAME;
}

/** Rewrites every `field: 'number'` leaf in `node` to `field: 'id'`, returning a
 * new tree (the caller replaces the whole `filters`/`relation_filter` value —
 * cheaper and safer than mutating in place given the tolerant, untyped input). */
function rewriteFilter(node: unknown): unknown {
  if (!isRecord(node)) return node;
  if (Array.isArray(node['and'])) return { ...node, and: (node['and'] as unknown[]).map(rewriteFilter) };
  if (Array.isArray(node['or'])) return { ...node, or: (node['or'] as unknown[]).map(rewriteFilter) };
  if (node['field'] === OLD_API_NAME) return { ...node, field: NEW_API_NAME };
  return node;
}

export interface ConfigScanResult {
  /** True if ANY of the locations below still reference the old api_name/id. */
  hit: boolean;
  locations: string[];
}

/** Scans one view's raw `config` for every remaining reference to `number`
 * (api_name) or `__sys_number` (the hidden_field_ids synthetic id). Named
 * locations, not just a boolean, so a post-migration failure is diagnosable. */
export function scanConfigForNumberRefs(config: unknown): ConfigScanResult {
  const locations: string[] = [];
  if (!isRecord(config)) return { hit: false, locations };
  const c = config as RawViewConfig;

  if (filterReferencesOldName(c.filters)) locations.push('filters');
  if (Array.isArray(c.sorts) && c.sorts.some((s) => isRecord(s) && s['field'] === OLD_API_NAME)) {
    locations.push('sorts');
  }
  if (Array.isArray(c.hidden_field_ids) && c.hidden_field_ids.includes(OLD_SYSTEM_ID)) {
    locations.push('hidden_field_ids');
  }
  if (Array.isArray(c.dashboard_tiles)) {
    (c.dashboard_tiles as RawTile[]).forEach((t, i) => {
      if (t.field_api_name === OLD_API_NAME) locations.push(`dashboard_tiles[${i}].field_api_name`);
      if (filterReferencesOldName(t.filter)) locations.push(`dashboard_tiles[${i}].filter`);
    });
  }
  if (Array.isArray(c.dashboard_widgets)) {
    (c.dashboard_widgets as RawWidget[]).forEach((w, i) => {
      if (w.group_by_field_api_name === OLD_API_NAME) locations.push(`dashboard_widgets[${i}].group_by_field_api_name`);
      if (w.measure?.field_api_name === OLD_API_NAME) locations.push(`dashboard_widgets[${i}].measure.field_api_name`);
      if (filterReferencesOldName(w.filter)) locations.push(`dashboard_widgets[${i}].filter`);
    });
  }
  if (Array.isArray(c.summary_widgets)) {
    (c.summary_widgets as RawTile[]).forEach((s, i) => {
      if (s.field_api_name === OLD_API_NAME) locations.push(`summary_widgets[${i}].field_api_name`);
      if (s['group_by_field_api_name'] === OLD_API_NAME) locations.push(`summary_widgets[${i}].group_by_field_api_name`);
    });
  }
  if (isRecord(c.form) && Array.isArray(c.form.fields)) {
    (c.form.fields as RawFormField[]).forEach((f, i) => {
      if (filterReferencesOldName(f.relation_filter)) locations.push(`form.fields[${i}].relation_filter`);
    });
  }

  return { hit: locations.length > 0, locations };
}

/** Rewrites every reference found by scanConfigForNumberRefs, returning a new
 * config object (or the SAME reference, unchanged, when there's nothing to do —
 * callers use that to skip a write). */
export function rewriteConfigNumberRefs(config: unknown): unknown {
  if (!isRecord(config) || !scanConfigForNumberRefs(config).hit) return config;
  const c = { ...(config as RawViewConfig) };

  if (c.filters !== undefined) c.filters = rewriteFilter(c.filters);
  if (Array.isArray(c.sorts)) {
    c.sorts = c.sorts.map((s) => (isRecord(s) && s['field'] === OLD_API_NAME ? { ...s, field: NEW_API_NAME } : s));
  }
  if (Array.isArray(c.hidden_field_ids)) {
    c.hidden_field_ids = c.hidden_field_ids.map((id) => (id === OLD_SYSTEM_ID ? NEW_SYSTEM_ID : id));
  }
  if (Array.isArray(c.dashboard_tiles)) {
    c.dashboard_tiles = (c.dashboard_tiles as RawTile[]).map((t) => ({
      ...t,
      ...(t.field_api_name === OLD_API_NAME ? { field_api_name: NEW_API_NAME } : {}),
      ...(t.filter !== undefined ? { filter: rewriteFilter(t.filter) } : {}),
    }));
  }
  if (Array.isArray(c.dashboard_widgets)) {
    c.dashboard_widgets = (c.dashboard_widgets as RawWidget[]).map((w) => ({
      ...w,
      ...(w.group_by_field_api_name === OLD_API_NAME ? { group_by_field_api_name: NEW_API_NAME } : {}),
      ...(w.measure ? { measure: { ...w.measure, ...(w.measure.field_api_name === OLD_API_NAME ? { field_api_name: NEW_API_NAME } : {}) } } : {}),
      ...(w.filter !== undefined ? { filter: rewriteFilter(w.filter) } : {}),
    }));
  }
  if (Array.isArray(c.summary_widgets)) {
    c.summary_widgets = (c.summary_widgets as RawTile[]).map((s) => ({
      ...s,
      ...(s.field_api_name === OLD_API_NAME ? { field_api_name: NEW_API_NAME } : {}),
      ...(s['group_by_field_api_name'] === OLD_API_NAME ? { group_by_field_api_name: NEW_API_NAME } : {}),
    }));
  }
  if (isRecord(c.form) && Array.isArray(c.form.fields)) {
    c.form = {
      ...c.form,
      fields: (c.form.fields as RawFormField[]).map((f) =>
        f.relation_filter !== undefined ? { ...f, relation_filter: rewriteFilter(f.relation_filter) } : f,
      ),
    };
  }

  return c;
}

/** Re-exported so a test/caller can assert against the exact rewritten AST
 * shape without re-deriving what "old"/"new" mean. */
export const NUMBER_FIELD_REF_NAMES = { OLD_API_NAME, NEW_API_NAME, OLD_SYSTEM_ID, NEW_SYSTEM_ID } as const;
export type { FilterNode };
