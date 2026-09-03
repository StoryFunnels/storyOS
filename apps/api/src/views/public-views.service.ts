import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { ViewConfig } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, views } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { RecordsService } from '../records/records.service';

/** Field types whose config can read data the public visitor is never shown —
 *  a rollup/lookup aggregates the RELATED database, a formula can reference
 *  one. Never exposed by the "non-hidden fields" default; only when
 *  `visible_field_api_names` EXPLICITLY names them (#264's "subtle hole"). */
const COMPUTED_TYPES = new Set(['rollup', 'lookup', 'formula']);

/**
 * Public (unauthenticated) read of a published view (#264). Mirrors
 * `FormsService`'s shape deliberately — same token-is-the-only-credential
 * design, same "resolve, then 404 on anything that isn't cleanly public"
 * posture — but is NOT the same resolver: a form's token lives at
 * `config.form.public_token`, this one at `config.share.public_token`, and
 * per Mira's note on the ticket, unifying them isn't attempted here — the two
 * have different shapes (a form's token is set by an ordinary PATCH; a view's
 * is minted server-side and immutable across allowlist edits, see
 * `ViewsService.share`) and forcing one resolver over both would be the kind
 * of premature unification that makes neither shape fit cleanly. Both do stay
 * on the SAME jsonb-lookup-plus-throttle pattern, so they can't drift in
 * spirit even while staying two functions.
 */
@Injectable()
export class PublicViewsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly records: RecordsService,
  ) {}

  /** Resolve a public token → its view + database + share config, or 404. */
  private async resolve(token: string) {
    const [view] = await this.db
      .select()
      .from(views)
      .where(and(sql`${views.config} -> 'share' ->> 'public_token' = ${token}`, notDeleted(views.deletedAt)))
      .limit(1);
    if (!view) throw new NotFoundException('View not found');
    const share = ((view.config as ViewConfig | null)?.share ?? {}) as NonNullable<ViewConfig['share']>;
    if (!share.public_token) throw new NotFoundException('View not found'); // defensive: matches the query above
    // #306/#347 — a dashboard (or any space-owned view) has no single set of
    // records or fields to allowlist; this ticket's whole mechanism ("records
    // via the view's own filter+sorts") presupposes exactly one database.
    // `ViewsService.share` already refuses these; this is the read-side mirror.
    if (!view.databaseId) throw new NotFoundException('View not found');
    const database = await this.db.query.databases.findFirst({
      // #453 — a soft-deleted database's view must not stay reachable just
      // because its share token still resolves; notDeleted matches every
      // other read path's rule.
      where: and(eq(databases.id, view.databaseId), notDeleted(databases.deletedAt)),
    });
    if (!database) throw new NotFoundException('View not found');
    return { view, share, database };
  }

  /**
   * The public view definition: which columns/relations a visitor sees, plus
   * one page of records — already computed (relations/attachments/lookups/
   * rollups/formulas all run normally via `RecordsService.query`, exactly the
   * pipeline a signed-in read uses) and THEN redacted down to the allowlist.
   * Stripping happens here, on the way OUT of the service, never left to the
   * client — the response body is the actual security boundary.
   */
  async getPublicView(token: string, opts: { cursor?: string }) {
    const { view, share, database } = await this.resolve(token);
    const config = (view.config ?? {}) as ViewConfig;

    const defs = await this.records.fieldDefs(database.id);
    const hiddenIds = new Set(config.hidden_field_ids ?? []);
    const defaultVisible = defs.filter((f) => !hiddenIds.has(f.id)).map((f) => f.api_name);
    const explicitAllowlist = share.visible_field_api_names;
    const requestedNames = new Set(explicitAllowlist ?? defaultVisible);

    const relationApiNames = new Set(share.include_relation_api_names ?? []);
    const exposedApiNames = new Set(
      defs
        .filter((f) => {
          if (!requestedNames.has(f.api_name)) return false;
          if (f.type === 'relation') return false; // handled separately, below
          // A computed field is exposed ONLY when an explicit allowlist named
          // it — never by the "non-hidden fields" default, since it can read
          // data the visitor was never shown.
          if (COMPUTED_TYPES.has(f.type)) return Boolean(explicitAllowlist) && requestedNames.has(f.api_name);
          return true;
        })
        .map((f) => f.api_name),
    );

    const result = await this.records.query(
      database.id,
      {
        filter: config.filters,
        sorts: config.sorts ?? [],
        nulls: config.sorts_nulls,
        limit: 50,
        cursor: opts.cursor,
      },
      '', // no signed-in visitor — nothing in a shared view's filter should key off "me"
      undefined, // no membership: relation-chip resolution isn't guest-scoped here because
      // this method does its OWN, stricter redaction below (drop unless explicitly
      // allowlisted) rather than relying on AccessService's per-viewer rules, which
      // don't apply to an anonymous visitor at all.
    );

    const records = result.data.map((record) => {
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record.values)) {
        if (relationApiNames.has(key) || exposedApiNames.has(key)) values[key] = value;
      }
      return { id: record.id, title: record.title, number: record.number, values };
    });

    return {
      view: { id: view.id, name: view.name, type: view.type },
      database: { name: database.name },
      fields: defs
        .filter((f) => exposedApiNames.has(f.api_name) || relationApiNames.has(f.api_name))
        .map((f) => ({ api_name: f.api_name, type: f.type })),
      indexable: share.indexable ?? false,
      records: { data: records, next_cursor: result.next_cursor, has_more: result.has_more },
    };
  }
}
