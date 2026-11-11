/**
 * Ticket #1221 — GitHub's "Not tracked, but sending events" list.
 *
 * A repository outside the selection still sends deliveries; they are answered 200 and dropped, which looks exactly like a healthy
 * silent connection (#828). The API reports them as `ignored_deliveries`; this turns that into the rows and the one action a row
 * has: Track. Pure so the count, the "first 3, then N more" cut and the request Track sends are tested without a browser.
 */
export interface IgnoredDeliveries {
  repos: Array<{ repo: string; count: number; last_seen_at: string; /** The webhook event of the latest delivery (`push`, `pull_request`…). The API stores and returns it. */ last_event?: string }>;
  /** Deliveries (not repositories) from repositories past the API's cap on named ones. */
  other_count: number;
}

export const UNTRACKED_PREVIEW_ROWS = 3;

export interface UntrackedModel {
  /** Null when there is nothing to say: no box at all. */
  title: string | null;
  /** The muted "N repositories" at the right of the header row; null when only unnamed deliveries are left. */
  count: string | null;
  rows: IgnoredDeliveries['repos'];
  /** Named repositories hidden behind "Show all". */
  hiddenCount: number;
  /** Deliveries from repositories the API only counts; shown as one muted line, never as rows (they have no name to Track). */
  otherDeliveries: number;
}

/** `tracked` is the CURRENT selection from a fresh read: a repository in it is never listed, whatever the delivery tally still says. */
export function untrackedModel(
  ignored: IgnoredDeliveries | undefined,
  tracked: readonly string[],
  showAll: boolean,
): UntrackedModel {
  const repos = (ignored?.repos ?? []).filter((r) => !tracked.includes(r.repo));
  const otherDeliveries = ignored?.other_count ?? 0;
  if (repos.length === 0 && otherDeliveries === 0)
    return { title: null, count: null, rows: [], hiddenCount: 0, otherDeliveries: 0 };
  const visible = showAll ? repos : repos.slice(0, UNTRACKED_PREVIEW_ROWS);
  return {
    title: 'Not tracked, but sending events',
    count: repos.length > 0 ? `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}` : null,
    rows: visible,
    hiddenCount: repos.length - visible.length,
    otherDeliveries,
  };
}

/** A row's sub-line: "3 events · last push, <time>". The event type is named only when the API sent one (rows from before it was stored have none). */
export function untrackedDetail(r: IgnoredDeliveries['repos'][number], formatTime: (iso: string) => string): string {
  const last = r.last_event ? `last ${r.last_event}, ${formatTime(r.last_seen_at)}` : `last ${formatTime(r.last_seen_at)}`;
  return `${r.count} ${r.count === 1 ? 'event' : 'events'} · ${last}`;
}

/** The body of the existing repository-selection call (POST /integrations/github `{ repos }`): the current selection plus this one. */
export function trackRequestBody(tracked: readonly string[], repo: string): { repos: string[] } {
  return { repos: tracked.includes(repo) ? [...tracked] : [...tracked, repo] };
}
