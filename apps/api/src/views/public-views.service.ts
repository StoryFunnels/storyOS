import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FilterNode, ViewConfig } from '@storyos/schemas';
import { BillingService } from '../billing/billing.service';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, selectOptions, views } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { PortalActivityService } from '../portal/portal-activity.service';
import { PortalRecipientsService } from '../portal/portal-recipients.service';
import { RecordsService } from '../records/records.service';
import { computePublicFieldAllowlist } from './views.service';

/**
 * #535 — a recipient-scope condition that can never match any real row. Used
 * when the resolving recipient has no usable value for the scope field (a
 * relation rule but no `linked_record_id`, or a text/email rule but no
 * `email`). Emptying the result set this way — rather than dropping the
 * condition — is what keeps the default fail-CLOSED: "no scoping value" must
 * read as "see nothing", never as "see everything". Filters on the built-in
 * `id` (public-number) system field, which every database has regardless of
 * the scope field's own type — a record number is never negative, so `-1`
 * matches nothing while staying a valid, always-compilable condition.
 */
const IMPOSSIBLE_CONDITION: FilterNode = { field: 'id', op: 'eq', value: -1 };

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
    private readonly portalRecipients: PortalRecipientsService,
    private readonly billing: BillingService,
    private readonly portalActivity: PortalActivityService,
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
  async getPublicView(token: string, opts: { cursor?: string; recipient?: string }) {
    const { view, share, database } = await this.resolve(token);
    const config = (view.config ?? {}) as ViewConfig;

    const defs = await this.records.fieldDefs(database.id);

    // #557 — field label + select-option label/color, the same shape
    // forms.service.ts already assembles for the public FORM page (#303).
    // These are workspace SCHEMA, not personal data — no privacy reason to
    // withhold them, and neither addition changes WHICH fields are exposed
    // (still gated by exposedApiNames/relationApiNames below).
    const fieldRows = await this.db.query.fields.findMany({
      where: eq(fields.databaseId, database.id),
    });
    const displayNameByApiName = new Map(fieldRows.map((f) => [f.apiName, f.displayName]));
    const selectFieldIds = fieldRows
      .filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow')
      .map((f) => f.id);
    const optionRows = selectFieldIds.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectFieldIds),
          orderBy: [asc(selectOptions.position)],
        })
      : [];
    const optionsByFieldId = new Map<string, Array<{ id: string; label: string; color: string }>>();
    for (const o of optionRows) {
      const list = optionsByFieldId.get(o.fieldId) ?? [];
      list.push({ id: o.id, label: o.label, color: o.color });
      optionsByFieldId.set(o.fieldId, list);
    }

    // #535 — a recipient-scope rule turns this from an open share link into a
    // portal: every request MUST resolve to a specific recipient, and that
    // recipient's rows are ANDed onto the view's own filter server-side. There
    // is no client-suppliable filter/sort/pagination on this endpoint at all
    // (only `cursor`, which is opaque and re-derived from THIS query), so
    // there is no tampering surface to close beyond resolving the token
    // itself correctly.
    const scopeFieldName = share.recipient_scope_field_api_name;
    let scopeCondition: FilterNode | undefined;
    const recipientScopeActive = Boolean(scopeFieldName);
    // #537 — set only once a recipient token resolves to a REAL, known row.
    // A garbage or revoked token never reaches this point (`resolveByToken`
    // throws first, and can't tell "no such recipient" from "revoked" apart)
    // — there is no recipientId to attribute an unresolvable attempt to, so
    // it is never logged. That is a deliberate scoping decision: this log is
    // "what each client did", not a generic hit log of unidentifiable
    // requests.
    let resolvedRecipient: { id: string } | undefined;
    if (scopeFieldName) {
      if (!opts.recipient) throw new ForbiddenException('recipient required');
      const recipient = await this.portalRecipients.resolveByToken(opts.recipient);
      resolvedRecipient = recipient;
      // Defense in depth: a recipient token is only ever minted for one
      // workspace. This view's database is denormalized to its own
      // workspaceId, so a token from a DIFFERENT workspace is rejected here
      // even though `resolveByToken` alone can't know which view it's for.
      if (recipient.workspaceId !== database.workspaceId) {
        await this.portalActivity.record({
          workspaceId: database.workspaceId,
          recipientId: recipient.id,
          viewId: view.id,
          outcome: 'rejected',
          reason: 'recipient belongs to a different workspace',
        });
        throw new ForbiddenException('invalid recipient');
      }

      const scopeField = defs.find((f) => f.api_name === scopeFieldName);
      if (!scopeField) {
        // The view's own scope rule names a field that no longer exists
        // (deleted after the rule was set). Fail closed, not open.
        scopeCondition = IMPOSSIBLE_CONDITION;
      } else if (scopeField.type === 'relation') {
        scopeCondition = recipient.linkedRecordId
          ? { field: scopeFieldName, op: 'has', value: [recipient.linkedRecordId] }
          : IMPOSSIBLE_CONDITION;
      } else {
        scopeCondition = recipient.email ? { field: scopeFieldName, op: 'eq', value: recipient.email } : IMPOSSIBLE_CONDITION;
      }
    }

    // #535, the #469-regression AC: a relation column pointing at out-of-scope
    // rows must expose NO title/id/preview, and the same holds for a
    // lookup/rollup computed over them — a rollup must never become an oracle
    // over another recipient's data. Reconciling per-relation scoping with the
    // row filter is exactly the "right filter, leaking traversal" shape #469
    // was, and #495 was closed Will Not Do trying to patch it client-side. The
    // conservative, provably-correct answer: while a recipient-scope rule is
    // active, NO relation/lookup/rollup/formula field is exposed at all,
    // regardless of `include_relation_api_names` or an explicit
    // `visible_field_api_names` allowlist naming one. See
    // `computePublicFieldAllowlist`'s own doc for why this is shared with
    // `ViewsService.share()`'s board/dashboard validation rather than a
    // second copy of this rule (#555).
    const { exposedApiNames, relationApiNames } = computePublicFieldAllowlist(defs, {
      hiddenFieldIds: config.hidden_field_ids,
      explicitAllowlist: share.visible_field_api_names,
      includeRelationApiNames: share.include_relation_api_names,
      recipientScopeActive,
    });

    const filter: FilterNode | undefined = scopeCondition
      ? config.filters
        ? { and: [config.filters, scopeCondition] }
        : scopeCondition
      : config.filters;

    const result = await this.records.query(
      database.id,
      {
        filter,
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

    // #555 — board grouping / dashboard tiles. `share()` already validates
    // these against the allowlist at PUBLISH time, but `hidden_field_ids`
    // (ordinary view config, not part of `share`) can change afterward
    // without a re-share — so this re-checks at READ time too, and defensive
    // reads DROP a now-stale reference rather than throwing (#305's rule:
    // unconfigured is not invalid). A whole board rendering ungrouped, or one
    // tile missing from a dashboard, beats 404ing the entire public page over
    // one field an owner happened to hide later.
    let board: {
      group_by_field_api_name: string | null;
      group_by_granularity: string | null;
      column_sort: string | null;
      hide_empty_groups: boolean;
      hide_empty_no_value_group: boolean;
    } | undefined;
    if (view.type === 'board') {
      const groupField = config.group_by_field_id ? defs.find((f) => f.id === config.group_by_field_id) : undefined;
      board = {
        group_by_field_api_name: groupField && exposedApiNames.has(groupField.api_name) ? groupField.api_name : null,
        group_by_granularity: config.group_by_granularity ?? null,
        column_sort: config.column_sort ?? null,
        hide_empty_groups: config.hide_empty_groups ?? false,
        hide_empty_no_value_group: config.hide_empty_no_value_group ?? false,
      };
    }

    // Dashboard TILES only (Phase 1) — dashboard WIDGETS (charts/grouped
    // tables, Phase 2 of the dashboard feature itself) are not exposed
    // publicly yet; that needs a grouped-aggregate query this ticket does not
    // build. Each tile's value is computed SERVER-SIDE via the same
    // `RecordsService.aggregate` the authenticated `/records/aggregate`
    // endpoint uses — never by shipping raw records to the client to reduce
    // there, which is what the authenticated dashboard still does today (its
    // own Phase 2 TODO) and would mean paginating an unbounded row set just
    // to compute one number for an anonymous visitor.
    let dashboardTiles:
      | Array<{
          id: string;
          label: string;
          op: string;
          field_api_name: string | null;
          value: number | null;
          layout: unknown;
          comparison: unknown;
        }>
      | undefined;
    if (view.type === 'dashboard') {
      const candidates = (config.dashboard_tiles ?? []).filter((tile) => {
        // Cross-database tiles have no allowlist to check against — dropped,
        // not rendered ungrouped-style, since there is no safe partial answer.
        if (tile.database_id && tile.database_id !== database.id) return false;
        return !tile.field_api_name || exposedApiNames.has(tile.field_api_name);
      });
      dashboardTiles = await Promise.all(
        candidates.map(async (tile) => {
          // The tile's OWN scope ANDed with the view's (which already carries
          // the recipient-scope condition, if active) — a tile must never
          // aggregate outside what THIS visitor's records query itself sees.
          const tileFilter: FilterNode | undefined = tile.filter
            ? (filter ? { and: [filter, tile.filter as FilterNode] } : (tile.filter as FilterNode))
            : filter;
          const agg = await this.records.aggregate(
            database.id,
            { op: tile.op, field: tile.field_api_name, filter: tileFilter },
            '', // no signed-in visitor, same as the records query above
          );
          return {
            id: tile.id,
            label: tile.label,
            op: tile.op,
            field_api_name: tile.field_api_name ?? null,
            value: agg.value,
            layout: tile.layout ?? null,
            comparison: tile.comparison ?? null,
          };
        }),
      );
    }

    // #556 — read-time, exactly like `FormsService`'s own hide_branding, so a
    // plan change takes effect immediately without needing to re-share.
    const billingStatus = await this.billing.getStatus(database.workspaceId);
    const hideBranding = billingStatus.plan !== 'free';

    // #537 — a resolved recipient reaching this point got a response, whether
    // or not the fail-closed scope left it empty; "served" answers "did they
    // look", not "did they see any rows". Fire-and-forget in spirit (record()
    // itself never throws) but still awaited, so a slow write can't reorder
    // ahead of the response it's logging.
    if (resolvedRecipient) {
      await this.portalActivity.record({
        workspaceId: database.workspaceId,
        recipientId: resolvedRecipient.id,
        viewId: view.id,
        outcome: 'served',
      });
    }

    return {
      view: { id: view.id, name: view.name, type: view.type },
      database: { name: database.name },
      fields: defs
        .filter((f) => exposedApiNames.has(f.api_name) || relationApiNames.has(f.api_name))
        .map((f) => ({
          api_name: f.api_name,
          type: f.type,
          label: displayNameByApiName.get(f.api_name) ?? f.api_name,
          ...(optionsByFieldId.has(f.id) ? { options: optionsByFieldId.get(f.id) } : {}),
        })),
      indexable: share.indexable ?? false,
      hide_branding: hideBranding,
      records: { data: records, next_cursor: result.next_cursor, has_more: result.has_more },
      ...(board ? { board } : {}),
      ...(dashboardTiles ? { dashboard: { tiles: dashboardTiles } } : {}),
    };
  }
}
