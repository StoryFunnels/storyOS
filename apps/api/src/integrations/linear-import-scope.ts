import { UnprocessableEntityException } from '@nestjs/common';
import { LINEAR_RECENT_DAYS } from '@storyos/schemas';
import type { LinearImportScope, ResolvedLinearImportOptions } from '@storyos/schemas';
import type { LinearFetcher } from './linear.service';

/**
 * Ticket #1393 — the import SCOPE: which of a team's issues an import reads at all.
 *
 * `open_and_recent` = every issue whose workflow state is not closed, plus every closed one (completed OR canceled) that closed
 * within the last LINEAR_RECENT_DAYS days. The filter is built from TWO halves that cannot overlap (open: state type not closed;
 * recently closed: state type closed AND a close date in the window), so the preview can count each half with one aliased request
 * and the import's own count check compares against the same filter. The filter shapes follow Linear's documented `IssueFilter`
 * (`state.type`, `completedAt`, `canceledAt`, `or`, `id.in`). They were NOT run against the live API: no Linear key existed.
 */

/** An id-only page of the scope walk (the connection's documented maximum). */
export const SCOPE_COUNT_PAGE_SIZE = 250;
/** The PREVIEW stops counting after this many pages and says "more than N": a count of a very large team is not worth an unbounded read. The import's own check has no cap. */
export const PREVIEW_COUNT_MAX_PAGES = 8;

/** Linear's workflow state types that mean "closed". Everything else (triage, backlog, unstarted, started) is open. */
export const CLOSED_STATE_TYPES = ['completed', 'canceled'] as const;

type Json = Record<string, unknown>;

/** The moment the "recent" window starts: `now` minus the window, as an ISO instant. */
export function scopeCutoff(nowMs: number, days: number = LINEAR_RECENT_DAYS): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/** Issues that are not closed — of any age. */
export const openIssuesFilter = (): Json => ({ state: { type: { nin: [...CLOSED_STATE_TYPES] } } });

/** Issues that are closed AND closed on or after the cutoff (a completion or a cancellation). */
export const closedRecentlyFilter = (cutoff: string): Json => ({
  state: { type: { in: [...CLOSED_STATE_TYPES] } },
  or: [{ completedAt: { gte: cutoff } }, { canceledAt: { gte: cutoff } }],
});

/** The whole default scope. An import with scope `all` sends no filter at all. */
export const scopeFilter = (cutoff: string): Json => ({ or: [openIssuesFilter(), closedRecentlyFilter(cutoff)] });

/** The filter an issue read sends: the scope, narrowed to what changed after `since` on an incremental run. */
export function issueScopeFilter(cutoff: string, since?: string): Json {
  return since ? { ...scopeFilter(cutoff), updatedAt: { gt: since } } : scopeFilter(cutoff);
}

/** The filter a comment read sends for its `issue`: this team's issues that are in scope. */
export function commentIssueFilter(teamId: string, cutoff: string): Json {
  return { team: { id: { eq: teamId } }, ...scopeFilter(cutoff) };
}

/** The filter that counts the open half / the recently closed half of ONE team's issues (the preview). */
export const teamOpenFilter = (teamId: string): Json => ({ team: { id: { eq: teamId } }, ...openIssuesFilter() });
export const teamClosedRecentlyFilter = (teamId: string, cutoff: string): Json => ({ team: { id: { eq: teamId } }, ...closedRecentlyFilter(cutoff) });

/** What a run does with the scope: the cutoff only exists for a filtered scope. */
export function cutoffFor(scope: LinearImportScope, nowMs: number): string | undefined {
  return scope === 'all' ? undefined : scopeCutoff(nowMs);
}

/** The options a workspace imported under before this ticket existed: everything, with history. Used only to read old state. */
export const LEGACY_IMPORT_OPTIONS: ResolvedLinearImportOptions = { scope: 'all', include_history: true };

export const sameImportOptions = (a: ResolvedLinearImportOptions, b: ResolvedLinearImportOptions): boolean =>
  a.scope === b.scope && a.include_history === b.include_history;

/** Linear `id: { in: [...] }` gets at most this many ids per request: a sixteen-thousand-id filter is not a request anyone documents. */
export const IDS_CHUNK = 100;
export function chunked<T>(items: readonly T[], size: number = IDS_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build a query from another by exact text replacement, and FAIL AT LOAD if a replacement matched nothing. The derived
 * queries (`...Scoped`, `...ByIds`) are textual, so a base query that is ever reworded must break loudly here and not quietly
 * send a different query than the one the tests exercise.
 */
export function deriveQuery(base: string, replacements: Array<[from: string, to: string]>, name: string): string {
  let out = base;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error(`${name} no longer derives from its base query: ${JSON.stringify(from)} not found`);
    out = out.replace(from, to);
  }
  return out;
}

/**
 * Counting what a filter matches. `Team.issueCount` takes ONE argument, `includeArchived` (Linear's published schema), so it cannot count a
 * scope. The count is a walk of `issues(filter: { team, ... })` that reads ids only, 250 to a page. `maxPages` bounds it (the preview); with no
 * bound it reads to the end (the import's completeness check). Hitting the bound is reported as `more_than: true` with the ids counted so
 * far - never null, never 0.
 */
export const TEAM_SCOPE_IDS_QUERY = `query TeamScopeIds($after: String, $filter: IssueFilter!) { issues(first: ${SCOPE_COUNT_PAGE_SIZE}, after: $after, filter: $filter) { nodes { id } pageInfo { hasNextPage endCursor } } }`;

/** `{ count, more_than }`: an exact count, or - when the walk stopped at its page cap - the number counted and `more_than: true`. */
export interface ScopeCount { count: number; more_than: boolean }

export async function countScopeIds(fetcher: LinearFetcher, apiKey: string, filter: Json, what: string, maxPages?: number): Promise<ScopeCount> {
  let count = 0;
  let after: string | undefined;
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const data = (await fetcher(TEAM_SCOPE_IDS_QUERY, after ? { filter, after } : { filter }, apiKey)) as { issues?: { nodes?: unknown[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } };
    const conn = data.issues;
    if (!conn || !Array.isArray(conn.nodes) || !conn.pageInfo) throw new UnprocessableEntityException(`Linear returned no issue list for the count of ${what} - refusing to show a number it did not give`);
    count += conn.nodes.length;
    if (!conn.pageInfo.hasNextPage) return { count, more_than: false };
    if (maxPages !== undefined && page >= maxPages) return { count, more_than: true };
    const next = conn.pageInfo.endCursor;
    if (!next || seen.has(next)) throw new UnprocessableEntityException(`Linear paging for the count of ${what} stopped advancing after ${count} ids - refusing to show a partial count`);
    seen.add(next);
    after = next;
  }
}
