import { isSettingsPath } from '@/lib/settings-nav';

/** A database's own page (`/w/:ws/d/:db`), where the view toolbar carries its own "+ New" (ticket #1275 item 10). */
const DATABASE_PAGE = /^\/w\/[^/]+\/d\/[^/]+\/?$/;

/**
 * Whether the phone's floating "+" (new record) is offered on this page. Not on Settings, which has nothing to create and where
 * the button sat on top of the last card at 390 wide (ticket #1216). Not on a database's page either: the view toolbar's own New
 * is right there and creates IN that database, so a second "+" in the corner was two "new" controls on one screen (ticket #1275
 * item 10) — and the corner one opens a database picker, the less direct of the two. A record page, Home, Me and the rest keep it.
 *
 * Known cost: a database page whose toolbar has no New (a dashboard view, or a read-only viewer) now has no floating "+" either.
 * A read-only viewer cannot create anyway; a dashboard reaches New through its database's other views.
 */
export function showQuickAddFab(pathname: string | null | undefined): boolean {
  if (isSettingsPath(pathname)) return false;
  return !(pathname && DATABASE_PAGE.test(pathname));
}
