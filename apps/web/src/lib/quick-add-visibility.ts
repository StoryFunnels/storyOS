import { isSettingsPath } from '@/lib/settings-nav';

/** A database's own page (`/w/:ws/d/:db`), where a view toolbar is drawn (ticket #1275 item 10). */
const DATABASE_PAGE = /^\/w\/[^/]+\/d\/[^/]+\/?$/;

/**
 * Whether the phone's floating "+" (new record) is offered on this page. Not on Settings, which has nothing to create and where
 * the button sat on top of the last card at 390 wide (ticket #1216). On a database's page it is the toolbar's New or the corner
 * "+", never both (ticket #1275 item 10, Otto 2026-11-13): hidden while the toolbar has its own New, SHOWN where it has none (a
 * dashboard view; see `toolbar-new-signal.ts`, which the toolbar reports into). A record page, Home, Me and the rest keep it.
 */
export function showQuickAddFab(pathname: string | null | undefined, toolbarLacksNew = false): boolean {
  if (isSettingsPath(pathname)) return false;
  if (pathname && DATABASE_PAGE.test(pathname)) return toolbarLacksNew;
  return true;
}
