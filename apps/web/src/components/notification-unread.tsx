import { cn } from '@/lib/utils';

/**
 * Ticket #1279 — ONE definition of "how an unread notification looks", used by the slide-over (inbox-panel.tsx)
 * and the full Inbox page (app/w/[ws]/inbox/page.tsx). Before, the page marked unread with a background one or two
 * levels off the app background (invisible) and the panel with a dot, so the two surfaces disagreed.
 *
 * Unread is `read_at === null` on the notification row and nothing else. Three cues carry it, so none depends on
 * colour alone: a dot, a heavier actor name, and the soft tint. The marker is the primary (navy) dot, not gold:
 * gold is reserved for where an agent acts.
 */

/** The row's state background. A selected row wins over the unread tint: the later of two bg-* classes would
 * otherwise silently win, and the row being read lost its selected look (ticket #1279 item 2). */
export function notificationRowStateClass({ unread, selected }: { unread: boolean; selected?: boolean }): string {
  if (selected) return 'bg-active';
  return unread ? 'bg-hover-soft' : '';
}

/** The actor name in a list row: heavier when unread (the cue that survives a selected background). */
export function notificationActorClass(unread: boolean): string {
  return unread ? 'font-semibold' : 'font-medium';
}

/** Whether a row counts as unread. The real flag only; `archived` rows are listed as history, not as new. */
export function isUnreadRow(n: { read_at: string | null }, opts?: { archivedView?: boolean }): boolean {
  return n.read_at === null && !opts?.archivedView;
}

/** The unread dot. Named for assistive tech, so "unread" is not conveyed by a coloured circle alone. */
export function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Unread"
      data-testid="notification-unread-dot"
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-primary-text', className)}
    />
  );
}
