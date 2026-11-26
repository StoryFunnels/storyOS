import { toast } from 'sonner';
import { recordHref } from '@/lib/records';

/**
 * Ticket #1339 (API half: ticket #1333, PR 1612) - a record made with "New" from a view can still land OUTSIDE that view
 * (a text or date filter has no value the server could pre-fill). The create response says so with
 * `view_match: { matches, unmet }`, and the person must be told, or the record they just made seems to vanish.
 *
 * `view_match` is present only when `view_id` was sent AND the view was readable AND the server could evaluate the filter.
 * ABSENT therefore means "unknown" and shows nothing: it is never read as "in the view", and never as "not in it".
 *
 * This is the ONE place that decides. Every create that starts from a view goes through `useRecordMutations`, which calls
 * `announceViewMatch`; a surface does not re-case the response.
 */

export interface ViewMatch {
  matches: boolean;
  /** `api_name` of each field behind a filter condition the record does not meet. Never ids. */
  unmet: string[];
}

export interface ViewMatchNotice {
  text: string;
  /** The record's per-database number, null when the response carried none. */
  number: number | null;
  unmet: string[];
}

/** The create response, as far as this decision reads it. The generated SDK type does not carry `view_match` yet. */
export interface CreatedWithViewMatch {
  number?: number | null;
  view_match?: ViewMatch | null;
}

/** `null` = say nothing. Only an explicit `matches: false` produces a notice. */
export function viewMatchNotice(created: CreatedWithViewMatch | null | undefined): ViewMatchNotice | null {
  const vm = created?.view_match;
  if (!vm || typeof vm !== 'object' || vm.matches !== false) return null;
  const number = typeof created?.number === 'number' ? created.number : null;
  return {
    text: number === null ? 'Created — not shown in this view' : `Created #${number} — not shown in this view`,
    number,
    unmet: Array.isArray(vm.unmet) ? vm.unmet : [],
  };
}

/** Shows the toast for a record that is not in the view. The Open link is the plain record href, never `?new=1`. */
export function announceViewMatch(
  created: (CreatedWithViewMatch & { id: string; title?: string | null }) | null | undefined,
  where: { ws: string; db: string; push: (href: string) => void },
): void {
  const notice = viewMatchNotice(created);
  if (!notice || !created) return;
  toast(notice.text, {
    duration: 8000,
    action: { label: 'Open', onClick: () => where.push(recordHref(where.ws, where.db, created)) },
  });
}
