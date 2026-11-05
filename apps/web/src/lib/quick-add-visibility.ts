import { isSettingsPath } from '@/lib/settings-nav';

/**
 * Whether the phone's floating "+" (new record) is offered on this page (ticket #1216). Settings has nothing to create, and the
 * button sat on top of the last Settings card at 390 wide, hiding its text (found reviewing ticket #1185). Everywhere else it stays.
 */
export function showQuickAddFab(pathname: string | null | undefined): boolean {
  return !isSettingsPath(pathname);
}
