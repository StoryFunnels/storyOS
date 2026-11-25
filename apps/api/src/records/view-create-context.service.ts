import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { activeFilter, type FieldDef, type FilterNode } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, views } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { ViewerStateService } from '../viewer-state/viewer-state.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { filterReferencedFields } from './query-compiler';
import { RecordsService } from './records.service';
import { deriveViewDefaults, filterUnits } from './view-defaults';

/** What a create that named a view reports back: did the new record land inside it, and which of its conditions it does not meet. */
export interface ViewMatch {
  matches: boolean;
  /** api_names of the fields behind every condition the new record does not satisfy. Empty when `matches` is true. */
  unmet: string[];
}

/** The view a create was made on, resolved for ONE caller: the filter that caller sees through it, and the field defs it runs against. */
export interface ViewCreateContext {
  databaseId: string;
  viewId: string;
  filter: FilterNode | undefined;
  defs: FieldDef[];
}

/**
 * ticket #1333 — "New" on a filtered view lands the record INSIDE that view.
 *
 * The web (and an MCP caller) names the view it is creating from (`view_id`); the rule for what that means for the new record lives
 * here, once, so a surface cannot re-case it (the field-surfaces rule). Three steps, in the order a create uses them:
 *  1. `resolve`: the view as THIS caller may see it, or nothing. Another member's personal view, a view of a different database, a
 *     trashed view and an id that does not exist are all the same answer (nothing, no error), so the call neither reveals that such a
 *     view exists nor leaks its filter through the values it would have set. The effective filter is the shared one AND the caller's
 *     own personal override (#259), because that is what the caller actually sees on screen.
 *  2. `defaults`: what the filter requires (`deriveViewDefaults`), minus anything the create could not accept.
 *  3. `match`: AFTER the create, the real evaluator (`compileFilter`, the one every view and query uses) is asked whether the record
 *     is in the view, so the answer is the product's own and never a second opinion from the derivation.
 */
@Injectable()
export class ViewCreateContextService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
    private readonly viewerState: ViewerStateService,
  ) {}

  async resolve(membership: Membership, databaseId: string, viewId: string): Promise<ViewCreateContext | undefined> {
    const view = await this.db.query.views.findFirst({
      where: and(eq(views.id, viewId), eq(views.databaseId, databaseId), notDeleted(views.deletedAt)),
      columns: { id: true, ownerUserId: true, config: true },
    });
    if (!view) return undefined;
    // Another member's personal view does not exist as far as this caller is concerned (private from admins too, ADR-0017).
    if (view.ownerUserId && view.ownerUserId !== membership.userId) return undefined;
    const shared = activeFilter(((view.config ?? {}) as { filters?: FilterNode }).filters);
    const personal = await this.viewerState.get(membership, 'view_filter', viewId, databaseId).catch(() => undefined);
    const mine = activeFilter(personal as FilterNode | undefined);
    const filter: FilterNode | undefined = shared && mine ? { and: [shared, mine] } : (shared ?? mine);
    return { databaseId, viewId, filter, defs: await this.recordsService.fieldDefs(databaseId) };
  }

  /** The view-derived defaults a create may add UNDER what the caller supplied (a supplied key, even null, always wins). */
  async defaults(
    ctx: ViewCreateContext,
    workspaceId: string,
    input: Record<string, unknown>,
    membership: Membership,
  ): Promise<Record<string, unknown>> {
    const derived = deriveViewDefaults(ctx.filter, ctx.defs, membership.userId);
    const wanted = Object.fromEntries(Object.entries(derived).filter(([key]) => !(key in input)));
    return this.recordsService.creatableViewDefaults(workspaceId, ctx.databaseId, ctx.defs, wanted, membership.userId, membership);
  }

  /** Is the freshly created record inside the view, and which conditions are not met? `undefined` when the evaluator cannot say. */
  async match(ctx: ViewCreateContext, recordId: string, membership: Membership): Promise<ViewMatch | undefined> {
    if (!ctx.filter) return { matches: true, unmet: [] };
    try {
      const inView = (unit: FilterNode) => this.recordMatches(ctx.databaseId, recordId, unit, membership);
      if (await inView(ctx.filter)) return { matches: true, unmet: [] };
      const unmet = new Set<string>();
      for (const unit of filterUnits(ctx.filter)) {
        if (!(await inView(unit))) for (const field of filterReferencedFields(unit)) unmet.add(field);
      }
      return { matches: false, unmet: [...unmet] };
    } catch {
      // A filter this caller cannot evaluate (a narrowed guest naming a hidden field): say nothing rather than a wrong verdict.
      return undefined;
    }
  }

  private async recordMatches(databaseId: string, recordId: string, filter: FilterNode, membership: Membership): Promise<boolean> {
    const where = await this.recordsService.aggregateWhere(databaseId, { filter }, membership.userId, membership);
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(records)
      .where(and(eq(records.id, recordId), where));
    return (row?.n ?? 0) > 0;
  }
}
