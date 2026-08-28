import type { DatabasesService } from '../databases/databases.service';
import type { RecordsService } from '../records/records.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import type { SourceAdapter, SourceField, SourceRecord, SourceRelationLink } from './types';

export interface StoryosSourceConfig {
  /** Whose permissions this read happens under. */
  membership: Membership;
  databaseId: string;
  /** The records to copy. Part of the CONFIG rather than a filter applied
   * afterwards — that is what lets one record and #435's bulk selection travel
   * the identical path with no second implementation. */
  recordIds: string[];
}

/** A field as the databases introspection payload returns it. */
interface LiveField {
  id: string;
  apiName: string;
  displayName: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
  relation?: { target_database_id: string };
}

/**
 * #431 — a StoryOS database as a migration source (#430's copy-to feature).
 *
 * The smallest adapter yet, and the only one whose source is already typed. CSV
 * and Linear both GUESS: `inferFieldType` exists because a CSV column is just
 * strings. Here the source type IS a StoryOS field type, so inference is not
 * merely unnecessary, it is lossy — a `select` holding two distinct values would
 * infer as `checkbox`, and a copy would silently change the shape of the data.
 * So this adapter never calls it, and a test asserts that.
 *
 * Two things it deliberately does NOT do, both because the contract says so:
 *
 *   It does not RESOLVE relations. `readRelations` returns raw target ids and
 *   resolution stays in the framework's relation-resolver. That would be easy to
 *   shortcut here — the ids are already StoryOS record ids, so "resolution" is
 *   the identity function — and taking the shortcut is exactly what would make
 *   this adapter special-cased in a pipeline built to treat every source alike.
 *
 *   It does not set `container`. That exists for multi-entity sources like
 *   Linear; #430 decided copy is 1→1, single-database.
 *
 * Reads go through DatabasesService/RecordsService rather than the tables
 * directly, so the caller's access to the SOURCE is checked by the same code
 * every other read path uses. An adapter that reached for `db.query` would
 * quietly become a way to read rows you cannot see.
 */
/*
 * NOT an @Injectable provider, matching LinearSourceAdapter. An adapter holds
 * per-copy state (the config and the source schema), so a singleton would let
 * two concurrent copies overwrite each other's `connect()`. Callers construct
 * one per operation and hand it the two services.
 */
export class StoryosSourceAdapter implements SourceAdapter<StoryosSourceConfig> {
  readonly key = 'storyos';

  private config: StoryosSourceConfig | null = null;
  private fields: LiveField[] = [];

  constructor(
    private readonly databases: DatabasesService,
    private readonly records: RecordsService,
  ) {}

  async connect(config: StoryosSourceConfig): Promise<void> {
    this.config = config;
    // Access-checked introspection: 404 without a grant, 403 below viewer.
    const detail = (await this.databases.get(config.membership, config.databaseId)) as { fields: LiveField[] };
    this.fields = detail.fields;
  }

  private must(): StoryosSourceConfig {
    if (!this.config) throw new Error('StoryosSourceAdapter.connect() must be called first');
    return this.config;
  }

  /**
   * The real StoryOS types, verbatim. `options` come from the FIELD DEFINITION,
   * not from observed values — for a typed source the schema is authoritative,
   * and sampling would miss any option nothing currently uses.
   */
  readSchema(): SourceField[] {
    return this.fields.map((f) => ({
      key: f.apiName,
      label: f.displayName,
      sourceType: f.type,
      ...(f.options?.length ? { options: f.options.map((o) => o.label) } : {}),
    }));
  }

  async readRecords(): Promise<SourceRecord[]> {
    const { databaseId, recordIds } = this.must();
    const out: SourceRecord[] = [];
    for (const id of recordIds) {
      const row = await this.readProjected(databaseId, id);
      out.push({
        sourceId: row.id,
        title: row.title,
        /*
         * Relation values are excluded here and read through readRelations()
         * instead. Carrying them in `fields` too would hand the mapping layer
         * two representations of the same edge, and #432's rules turn on the
         * relation representation specifically.
         */
        fields: Object.fromEntries(
          Object.entries(row.values).filter(([key]) => !this.isRelation(key)),
        ),
      });
    }
    return out;
  }

  /**
   * Outgoing links as RAW target ids, one entry per (record, relation field).
   *
   * A field with no links is OMITTED rather than emitted empty. "No edge" and
   * "an edge to nothing" are different things, and #432's blocking rule turns
   * on exactly that distinction: an empty relation must never block a copy,
   * because nothing would be lost by not carrying it.
   */
  async readRelations(): Promise<SourceRelationLink[]> {
    const { databaseId, recordIds } = this.must();
    const links: SourceRelationLink[] = [];
    for (const recordId of recordIds) {
      const row = await this.readProjected(databaseId, recordId);
      for (const field of this.fields) {
        if (field.type !== 'relation') continue;
        const toSourceIds = chipIds(row.values[field.apiName]);
        if (toSourceIds.length === 0) continue;
        links.push({ fromSourceId: recordId, fieldKey: field.apiName, toSourceIds });
      }
    }
    return links;
  }

  /** One access-checked read, shared by both passes. `records.get` is the same
   * projection the records API returns, so relation chips are already resolved
   * to `{id, title}` and nothing here re-implements that join. */
  private async readProjected(databaseId: string, recordId: string) {
    return (await this.records.get(databaseId, recordId)) as unknown as {
      id: string;
      title: string;
      values: Record<string, unknown>;
    };
  }

  private isRelation(apiName: string): boolean {
    return this.fields.some((f) => f.apiName === apiName && f.type === 'relation');
  }
}

/**
 * Relation chips project as `{id, title}` objects. Pulling out just the ids is
 * what keeps this adapter compliant with the contract's "resolution always
 * happens in the framework's relation-resolver, never in the adapter" — the
 * titles are right there and passing them along would be the shortcut that
 * makes this source special-cased in a pipeline built to treat all sources
 * alike.
 */
function chipIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : v))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
