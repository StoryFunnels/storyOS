import { UnprocessableEntityException } from '@nestjs/common';
import type { LinearFetcher } from './linear.service';
import { LinearApiError, shrinkQuery } from './linear-resilience';

export interface PageInfo { hasNextPage: boolean; endCursor: string | null }

/**
 * Walk one Linear connection to its end. Never assumes completeness: a response with no `pageInfo`, a `hasNextPage` with no
 * cursor, or a cursor that does not advance is an ERROR, because each of those would otherwise look like "that was
 * everything" — the exact silent partial import this replaces.
 *
 * Lives here (it used to sit in linear.service.ts) so the attachment and document reads (ticket #1366) walk their
 * connections with the very same function rather than a copy that could drift from it.
 */
export async function pageAll<T>(
  fetcher: LinearFetcher,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: never) => { nodes: T[]; pageInfo?: PageInfo } | undefined,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let currentQuery = query;
  for (;;) {
    let data: unknown;
    try {
      data = await fetcher(currentQuery, after ? { ...variables, after } : variables, apiKey);
    } catch (error) {
      // Ticket #1392 — Linear refused the page as too complex: ask for fewer rows per page and retry the SAME cursor, instead of
      // failing the import. The smaller size stays for the rest of this walk. Only when the page cannot shrink further does it fail.
      if (error instanceof LinearApiError && error.kind === 'complexity') {
        const smaller = shrinkQuery(currentQuery);
        if (!smaller) throw new UnprocessableEntityException(`${error.message} — even a page of ${/first: (\d+)/.exec(currentQuery)?.[1] ?? '?'} rows is too complex (${what})`);
        currentQuery = smaller;
        continue;
      }
      throw error;
    }
    const conn = pick(data as never);
    if (!conn || !Array.isArray(conn.nodes)) throw new UnprocessableEntityException(`Linear returned no ${what} — refusing to continue with a partial copy`);
    if (!conn.pageInfo) throw new UnprocessableEntityException(`Linear returned no pageInfo for ${what} — cannot tell whether the list is complete`);
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return out;
    const next = conn.pageInfo.endCursor;
    if (!next || seen.has(next)) {
      throw new UnprocessableEntityException(`Linear paging for ${what} stopped advancing after ${out.length} rows — refusing to continue with a partial copy`);
    }
    seen.add(next);
    after = next;
  }
}
