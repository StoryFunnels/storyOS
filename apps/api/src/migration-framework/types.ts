/**
 * The shared migration framework (#198 / MN-236, ADR-0013): a source-agnostic
 * pipeline — map → dry-run → chunked, resumable apply — that the CSV (MN-052)
 * and Linear (MN-066) importers now plug into, and that the four planned
 * competitor importers (#169–#172) will plug into the same way.
 *
 * Deliberately deferred from ADR-0013: the DB-level `records.source_system` /
 * `source_id` primitive. Its value is real (a DB-enforced dedup guarantee) but
 * it's a schema migration, and CLAUDE.md's one-in-flight-migration rule makes
 * that risky with several agents potentially landing migrations the same
 * night. Idempotent re-import is instead built on an ordinary field (e.g.
 * `linear_id`) via `ExternalIdUpsertService` — see external-id-upsert.service.ts.
 * Promoting that to a first-class column + unique index is a clean follow-up
 * once this framework has landed without colliding with anything else in flight.
 */

/** A field as read from an external source's schema. The framework maps this to a
 * StoryOS field type via the mapping layer before anything is created — adapters
 * never decide StoryOS field types themselves. */
export interface SourceField {
  /** Stable key in the source (CSV column header, a Linear API field name, …). */
  key: string;
  /** Human label a mapping UI shows next to the destination picker. */
  label: string;
  /** Source-specific type tag (CSV's inferred type, Linear's field kind, …). */
  sourceType: string;
  /** Known distinct values, when the source can offer them (select-like fields). */
  options?: string[];
}

/**
 * A single source record, flattened to key→value pairs keyed by `SourceField.key`.
 * Relation values are raw source-side hints (titles or source ids) — resolution
 * always happens in the framework's relation-resolver, never in the adapter.
 */
export interface SourceRecord {
  sourceId: string;
  /** Which source "table"/entity this record belongs to, for multi-container
   * sources like Linear (issue vs. project vs. cycle vs. label). */
  container?: string;
  title: string;
  fields: Record<string, unknown>;
  /** fieldKey -> raw target hints (titles or other records' sourceIds). */
  relations?: Record<string, string[]>;
}

/**
 * An explicit relation edge, for sources that resolve links after every record
 * exists rather than inline per-cell (e.g. Linear's parent/cycle/project refs,
 * which name a `sourceId` that may not have been created yet on this pass).
 */
export interface SourceRelationLink {
  fromSourceId: string;
  fieldKey: string;
  toSourceIds: string[];
}

/**
 * The contract every importer plugs into. A new source contributes only: how to
 * authenticate/connect, and how to read its schema/records/relations — the
 * map → dry-run → chunked-apply pipeline itself is framework code.
 */
export interface SourceAdapter<TConfig = unknown> {
  readonly key: string;
  connect(config: TConfig): Promise<void> | void;
  readSchema(): Promise<SourceField[]> | SourceField[];
  readRecords(): Promise<SourceRecord[]>;
  readRelations?(): Promise<SourceRelationLink[]> | SourceRelationLink[];
}

/** The field-mapping payload a mapping UI produces — generalizes MN-052's
 * `ColumnMapping` (`column` renamed to the source-agnostic `sourceKey`). */
export type FieldDestination =
  | { kind: 'title' }
  | { kind: 'existing'; field_id: string }
  | { kind: 'new'; display_name: string; type: string }
  | { kind: 'relation'; field_id: string }
  | { kind: 'skip' };

export interface FieldMapping {
  sourceKey: string;
  to: FieldDestination;
}

export interface ImportWarning {
  row?: number;
  recordKey?: string;
  column?: string;
  message: string;
}

export interface NewFieldSpec {
  display_name: string;
  type: string;
}

/**
 * The unified dry-run contract (ADR-0013 §4): counts + the new-fields preview +
 * a capped warnings list, before any write. `will_update` only makes sense for
 * adapters that upsert by an external id (see external-id-upsert.service.ts);
 * importers that only ever create (CSV v1, per MN-052's "no upsert" scope) leave
 * it at 0.
 */
export interface DryRunReport {
  will_create: number;
  will_update: number;
  new_fields: NewFieldSpec[];
  warnings: ImportWarning[];
  warnings_total: number;
  sample: Array<Record<string, unknown>>;
}
