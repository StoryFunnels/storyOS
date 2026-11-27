import { UnprocessableEntityException } from '@nestjs/common';
import type { LinearFetcher } from './linear.service';

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
  for (;;) {
    const data = await fetcher(query, after ? { ...variables, after } : variables, apiKey);
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
