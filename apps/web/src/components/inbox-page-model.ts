import { goldCountLabel } from '@/lib/sidebar-ai';
import type { NotificationType } from '@/components/inbox-panel';

/**
 * Ticket #1279 — the pure parts of the full Inbox page, kept out of the component so each rule has a test.
 */

export type InboxTabKey = NotificationType | 'all' | 'archived';

/** The page's tabs, in the reference's order. Archived is a tab, not a toggle at the far right of the bar. */
export const INBOX_TABS: Array<{ key: InboxTabKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'mentioned', label: 'Mentions' },
  { key: 'commented', label: 'Comments' },
  { key: 'state_changed', label: 'Status' },
  { key: 'action_approval_requested', label: 'Approvals' },
  { key: 'archived', label: 'Archived' },
];

/** What a tab asks the API for: the type filter and the archived flag are two parameters, and Archived has no type. */
export function inboxTabQuery(key: InboxTabKey): { type: NotificationType | 'all'; archived: boolean } {
  return key === 'archived' ? { type: 'all', archived: true } : { type: key, archived: false };
}

/**
 * The line under the page title. A real count or nothing: `undefined` (not loaded, or the read failed) returns null, because
 * "You're all caught up" about a count we do not have is a confident zero. Zero is the one number that gets words.
 */
export function inboxSubtitle(unread: number | undefined): string | null {
  if (unread === undefined || !Number.isFinite(unread) || unread < 0) return null;
  return unread === 0 ? 'You’re all caught up' : `${unread} unread`;
}

/**
 * The gold number on the Approvals tab: approval notifications still waiting for a decision. A row counts when its approval is
 * in the pending list. Both inputs are bounded (the notifications come a page at a time, the pending list is capped), so when
 * either could hold more than we saw the answer is a lower bound and says so ("3+"), never a bare number that could be wrong.
 * Returns null for nothing to show (zero is not drawn) and while either list is still unknown.
 */
export function waitingApprovalLabel(args: {
  rows: Array<{ ref_id: string | null }> | undefined;
  pendingIds: ReadonlySet<string> | undefined;
  moreRows: boolean;
  pendingCapped: boolean;
}): string | null {
  const { rows, pendingIds, moreRows, pendingCapped } = args;
  if (!rows || !pendingIds) return null;
  const count = rows.filter((r) => r.ref_id !== null && pendingIds.has(r.ref_id)).length;
  if (count <= 0) return null;
  const label = goldCountLabel(count) as string;
  return moreRows || pendingCapped ? `${label}+` : label;
}
