import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { recordLinks, records, relations, sources } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SourcesService } from '../sources/sources.service';
import {
  RELATION_KEY_FIELD,
  SHOPIFY_CATALOGUE,
  SHOPIFY_CATALOGUE_SOURCES,
  SHOPIFY_SOURCE_BY_ROLE,
  linkSetEqual,
  parseGid,
  parseGidList,
  resolveGids,
  type ShopifyCatalogueRole,
} from './shopify-catalogue';

/** Above this many collection rows, a product write skips the collection
 * back-fill scan (protects write latency; the next collections re-sync still
 * converges the links). Mirrors auto-link's ON_WRITE_MAX guard. */
const BACKFILL_SCAN_MAX = 2000;

type Relation = typeof relations.$inferSelect;
type SourceRow = typeof sources.$inferSelect;

interface ProvisionResult {
  space_id: string;
  databases: Record<ShopifyCatalogueRole, string>;
  relations: Array<{ key: string; id: string; field_a_id: string; field_b_id: string }>;
  sources: Array<{ role: ShopifyCatalogueRole; attached: boolean; error?: string }>;
  notes: string[];
}

/** The live catalogue wiring resolved from the workspace's shopify sources —
 * everything the link materializer needs, or null when there's no products
 * source to resolve GIDs against. */
interface CatalogueWiring {
  productsDbId: string;
  productsKeyFieldId: string; // field id storing each product's own GID (external key)
  variants?: { dbId: string; productGidFieldId: string; relation: Relation };
  collections?: { dbId: string; productGidsFieldId: string; relation: Relation };
}

/**
 * #110 — Shopify product-catalogue guided setup + relation materialization.
 *
 * `provision()` is the one-click that creates the three databases, attaches the
 * three `shopify.*` sources (best-effort, #109 style), pre-maps every field
 * (with the provider's `title` landing on the record Name, #125), and defines
 * the product↔variant and product↔collection relations.
 *
 * `materializeForRecord()` (driven by the domain-event subscriber) turns the
 * GID foreign keys the sync stores as text into real `record_links`: it resolves
 * a variant's `product_id` and a collection's `product_ids` to the product
 * records the products source created. Keyed by the immutable GID, so it is
 * idempotent (re-running yields the same links) and order-independent (a
 * variant/collection imported before its product resolves to nothing now and is
 * back-filled when the product write arrives).
 */
@Injectable()
export class ShopifyCatalogueService {
  private readonly logger = new Logger('ShopifyCatalogue');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databases: DatabasesService,
    private readonly fields: FieldsService,
    private readonly records: RecordsService,
    private readonly relations: RelationsService,
    private readonly sources: SourcesService,
  ) {}

  // ── provisioning ───────────────────────────────────────────────────────────

  async provision(
    membership: Membership,
    actorId: string,
    input: { space_id: string; connection_id: string; name_prefix?: string },
  ): Promise<ProvisionResult> {
    const workspaceId = membership.workspaceId;
    const prefix = input.name_prefix?.trim() ? `${input.name_prefix.trim()} ` : '';
    const notes: string[] = [];

    // 1. Databases + fields + field mapping (per role).
    const dbIdByRole = {} as Record<ShopifyCatalogueRole, string>;
    const mappingByRole = {} as Record<
      ShopifyCatalogueRole,
      { fieldMapping: Record<string, string>; externalKeyFieldId: string }
    >;

    for (const def of SHOPIFY_CATALOGUE) {
      const database = await this.databases.create(membership, {
        space_id: input.space_id,
        name: `${prefix}${def.name}`,
        icon: def.icon,
      });
      dbIdByRole[def.role] = database.id;

      const titleFieldId = await this.titleFieldId(database.id);
      const fieldMapping: Record<string, string> = {};
      let externalKeyFieldId: string | undefined;

      for (const fieldDef of def.fields) {
        if (fieldDef.to_name) {
          // The provider's title lands on the record Name/title system field (#125).
          fieldMapping[fieldDef.external_key] = titleFieldId;
          continue;
        }
        const field = (await this.fields.create(database.id, {
          display_name: fieldDef.display_name,
          type: fieldDef.type,
          config: {},
        })) as { id: string };
        fieldMapping[fieldDef.external_key] = field.id;
        if (fieldDef.is_key) externalKeyFieldId = field.id;
      }
      if (!externalKeyFieldId) {
        throw new Error(`Shopify catalogue "${def.role}" has no external-key field`);
      }
      mappingByRole[def.role] = { fieldMapping, externalKeyFieldId };
    }

    // 2. Relations between the three databases. Side A is the "many" side.
    const relationsOut: ProvisionResult['relations'] = [];
    const variantRel = await this.relations.create(membership, {
      database_a_id: dbIdByRole.variants,
      database_b_id: dbIdByRole.products,
      cardinality: 'one_to_many',
      field_a_name: 'Product',
      field_b_name: 'Variants',
    });
    relationsOut.push({ key: 'variants', id: variantRel.id, field_a_id: variantRel.field_a.id, field_b_id: variantRel.field_b.id });
    const collectionRel = await this.relations.create(membership, {
      database_a_id: dbIdByRole.collections,
      database_b_id: dbIdByRole.products,
      cardinality: 'many_to_many',
      field_a_name: 'Products',
      field_b_name: 'Collections',
    });
    relationsOut.push({ key: 'collections', id: collectionRel.id, field_a_id: collectionRel.field_a.id, field_b_id: collectionRel.field_b.id });

    // 3. Attach the three sources — best-effort (#109): a failure to attach one
    // source (e.g. the connection lacks a scope) must not lose the databases or
    // the other sources. Manual source-add stays as the fallback.
    const sourcesOut: ProvisionResult['sources'] = [];
    for (const def of SHOPIFY_CATALOGUE) {
      const map = mappingByRole[def.role];
      try {
        await this.sources.create(
          workspaceId,
          dbIdByRole[def.role],
          {
            name: `Shopify — ${def.role}`,
            connection_id: input.connection_id,
            provider_source: SHOPIFY_SOURCE_BY_ROLE[def.role],
            config: {},
            field_mapping: map.fieldMapping,
            external_key_field_id: map.externalKeyFieldId,
          },
          actorId,
        );
        sourcesOut.push({ role: def.role, attached: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sourcesOut.push({ role: def.role, attached: false, error: message });
        notes.push(`Could not attach the ${def.role} source automatically — add it manually from the database. (${message})`);
      }
    }

    return { space_id: input.space_id, databases: dbIdByRole, relations: relationsOut, sources: sourcesOut, notes };
  }

  /** The database's Name/title system field id (source `title` maps onto it, #125). */
  private async titleFieldId(databaseId: string): Promise<string> {
    const defs = await this.records.fieldDefs(databaseId);
    const title = defs.find((d) => d.type === 'title');
    if (!title) throw new Error('Database has no title field');
    return title.id;
  }

  // ── relation materialization (the load-bearing part) ─────────────────────────

  /**
   * Called by the subscriber after a record in a catalogue database is created
   * or updated. Fast-paths out for the overwhelming majority of writes (a single
   * indexed lookup on `sources.target_database_id`); only proceeds for a record
   * in one of this workspace's Shopify catalogue databases.
   */
  async materializeForRecord(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    actorId: string,
  ): Promise<void> {
    // Guard: is this database one a Shopify catalogue source targets? (indexed)
    const [hit] = await this.db
      .select({ provider: sources.providerSource })
      .from(sources)
      .where(
        and(
          eq(sources.workspaceId, workspaceId),
          eq(sources.targetDatabaseId, databaseId),
          inArray(sources.providerSource, [...SHOPIFY_CATALOGUE_SOURCES]),
        ),
      )
      .limit(1);
    if (!hit) return;

    const wiring = await this.resolveWiring(workspaceId);
    if (!wiring) return;

    if (databaseId === wiring.variants?.dbId) {
      await this.linkVariant(workspaceId, wiring, recordId, actorId);
    } else if (databaseId === wiring.collections?.dbId) {
      await this.linkCollection(workspaceId, wiring, recordId, actorId);
    } else if (databaseId === wiring.productsDbId) {
      await this.backfillForProduct(workspaceId, wiring, recordId, actorId);
    }
  }

  /** Resolve the live catalogue wiring from the workspace's shopify sources. */
  private async resolveWiring(workspaceId: string): Promise<CatalogueWiring | null> {
    const rows = await this.db.query.sources.findMany({
      where: and(
        eq(sources.workspaceId, workspaceId),
        inArray(sources.providerSource, [...SHOPIFY_CATALOGUE_SOURCES]),
      ),
    });
    const byProvider = new Map<string, SourceRow>();
    for (const row of rows) byProvider.set(row.providerSource, row);

    const products = byProvider.get(SHOPIFY_SOURCE_BY_ROLE.products);
    if (!products) return null; // no products source → nothing to resolve GIDs against

    const wiring: CatalogueWiring = {
      productsDbId: products.targetDatabaseId,
      productsKeyFieldId: products.externalKeyFieldId,
    };

    const variantSource = byProvider.get(SHOPIFY_SOURCE_BY_ROLE.variants);
    if (variantSource) {
      const productGidFieldId = (variantSource.fieldMapping as Record<string, string>)[RELATION_KEY_FIELD.variants];
      const relation = await this.findRelation(variantSource.targetDatabaseId, products.targetDatabaseId);
      if (productGidFieldId && relation) {
        wiring.variants = { dbId: variantSource.targetDatabaseId, productGidFieldId, relation };
      }
    }

    const collectionSource = byProvider.get(SHOPIFY_SOURCE_BY_ROLE.collections);
    if (collectionSource) {
      const productGidsFieldId = (collectionSource.fieldMapping as Record<string, string>)[RELATION_KEY_FIELD.collections];
      const relation = await this.findRelation(collectionSource.targetDatabaseId, products.targetDatabaseId);
      if (productGidsFieldId && relation) {
        wiring.collections = { dbId: collectionSource.targetDatabaseId, productGidsFieldId, relation };
      }
    }

    return wiring;
  }

  /** The relation whose side A is `dbAId` and side B is `dbBId` (as provision creates them). */
  private async findRelation(dbAId: string, dbBId: string): Promise<Relation | undefined> {
    return this.db.query.relations.findFirst({
      where: and(eq(relations.databaseAId, dbAId), eq(relations.databaseBId, dbBId)),
    });
  }

  /** Resolve a set of product GIDs to product record ids (dropping unresolved). */
  private async productIdsByGid(
    productsDbId: string,
    keyFieldId: string,
    gids: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (gids.length === 0) return map;
    const list = sql.join(
      gids.map((g) => sql`${g}`),
      sql`, `,
    );
    const rows = await this.db
      .select({ id: records.id, gid: sql<string | null>`(${records.values}->>${keyFieldId})` })
      .from(records)
      .where(
        and(
          eq(records.databaseId, productsDbId),
          isNull(records.deletedAt),
          sql`(${records.values}->>${keyFieldId}) IN (${list})`,
        ),
      );
    for (const row of rows) if (row.gid) map.set(row.gid, row.id);
    return map;
  }

  /** Current side-B record ids linked from a side-A record through a relation. */
  private async currentTargetIds(relationId: string, fromRecordId: string): Promise<string[]> {
    const rows = await this.db
      .select({ toRecordId: recordLinks.toRecordId })
      .from(recordLinks)
      .where(and(eq(recordLinks.relationId, relationId), eq(recordLinks.fromRecordId, fromRecordId)));
    return rows.map((r) => r.toRecordId);
  }

  /** Read a record's stored value for one field id (records.values is keyed by field id). */
  private async recordValue(recordId: string, fieldId: string): Promise<unknown> {
    const row = await this.db.query.records.findFirst({
      where: and(eq(records.id, recordId), isNull(records.deletedAt)),
      columns: { values: true },
    });
    if (!row) return undefined;
    return (row.values as Record<string, unknown>)[fieldId];
  }

  /** Set a side-A record's links to exactly `desired`, skipping when unchanged (idempotent). */
  private async setLinks(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    relation: Relation,
    desired: string[],
    actorId: string,
  ): Promise<void> {
    const current = await this.currentTargetIds(relation.id, recordId);
    if (linkSetEqual(current, desired)) return;
    await this.relations.replaceLinks(workspaceId, databaseId, recordId, relation.fieldAId, desired, actorId);
  }

  private async linkVariant(
    workspaceId: string,
    wiring: CatalogueWiring,
    variantRecordId: string,
    actorId: string,
  ): Promise<void> {
    if (!wiring.variants) return;
    const gid = parseGid(await this.recordValue(variantRecordId, wiring.variants.productGidFieldId));
    const desired = gid
      ? resolveGids([gid], await this.productIdsByGid(wiring.productsDbId, wiring.productsKeyFieldId, [gid]))
      : [];
    await this.setLinks(workspaceId, wiring.variants.dbId, variantRecordId, wiring.variants.relation, desired, actorId);
  }

  private async linkCollection(
    workspaceId: string,
    wiring: CatalogueWiring,
    collectionRecordId: string,
    actorId: string,
  ): Promise<void> {
    if (!wiring.collections) return;
    const gids = parseGidList(await this.recordValue(collectionRecordId, wiring.collections.productGidsFieldId));
    const desired = resolveGids(gids, await this.productIdsByGid(wiring.productsDbId, wiring.productsKeyFieldId, gids));
    await this.setLinks(workspaceId, wiring.collections.dbId, collectionRecordId, wiring.collections.relation, desired, actorId);
  }

  /**
   * A product was (re)synced — back-fill any variant/collection that referenced
   * its GID before it existed. This is what makes the materialization
   * order-independent within a single sync pass.
   */
  private async backfillForProduct(
    workspaceId: string,
    wiring: CatalogueWiring,
    productRecordId: string,
    actorId: string,
  ): Promise<void> {
    const gid = parseGid(await this.recordValue(productRecordId, wiring.productsKeyFieldId));
    if (!gid) return;

    // Variants whose stored parent GID is this product → (re)link each.
    if (wiring.variants) {
      const fieldId = wiring.variants.productGidFieldId;
      const variantRows = await this.db
        .select({ id: records.id })
        .from(records)
        .where(
          and(
            eq(records.databaseId, wiring.variants.dbId),
            isNull(records.deletedAt),
            sql`(${records.values}->>${fieldId}) = ${gid}`,
          ),
        );
      for (const row of variantRows) {
        await this.linkVariant(workspaceId, wiring, row.id, actorId);
      }
    }

    // Collections whose stored member list contains this GID → re-materialize.
    // product_ids is a comma-joined text, so membership is checked in JS after a
    // cheap LIKE prefilter, bounded by BACKFILL_SCAN_MAX.
    if (wiring.collections) {
      const fieldId = wiring.collections.productGidsFieldId;
      const count = await this.db.$count(
        records,
        and(eq(records.databaseId, wiring.collections.dbId), isNull(records.deletedAt)),
      );
      if (count > BACKFILL_SCAN_MAX) return;
      const collectionRows = await this.db
        .select({ id: records.id, list: sql<string | null>`(${records.values}->>${fieldId})` })
        .from(records)
        .where(
          and(
            eq(records.databaseId, wiring.collections.dbId),
            isNull(records.deletedAt),
            sql`(${records.values}->>${fieldId}) LIKE ${'%' + gid + '%'}`,
          ),
        );
      for (const row of collectionRows) {
        if (parseGidList(row.list).includes(gid)) {
          await this.linkCollection(workspaceId, wiring, row.id, actorId);
        }
      }
    }
  }
}
