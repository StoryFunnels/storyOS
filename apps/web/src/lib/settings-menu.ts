import {
  isSettingsLinkActive,
  isSettingsPath,
  settingsHomeHref,
  type SettingsNavGroup,
  type SettingsPageId,
} from '@/lib/settings-nav';
import type { SettingsNavCount } from '@/lib/settings-home';

/**
 * The Settings menu as drawn in the app sidebar (ticket #1216), as plain data so the choices (what is current, which count is a
 * warning) are testable without rendering. The groups and who may open what still come from `lib/settings-nav.ts`; this only
 * decides how they are presented.
 */

/** Which body the app sidebar shows below the workspace switcher and search: the settings menu on any Settings page, the space tree elsewhere. */
export type SidebarBody = 'settings' | 'tree';

export function sidebarBody(pathname: string | null | undefined): SidebarBody {
  return isSettingsPath(pathname) ? 'settings' : 'tree';
}

/** The colour of a count. An attention count is warning text (`--warning-text`, readable on the sidebar in both themes); a plain one is muted. */
export function settingsCountClass(count: Pick<SettingsNavCount, 'warn'>): string {
  return count.warn ? 'text-warning-text' : 'text-muted';
}

/**
 * Ticket #1282 — the current page's row is 650 weight on the beige fill, as the prototype draws it (it was 400: the fill alone said where you
 * are). Only the weight is added here; the fill and the rest of a row stay the sidebar row's own (`sidebarRowStateClass`).
 */
export function settingsRowWeightClass(active: boolean): string {
  return active ? 'font-[650]' : 'font-normal';
}

/** The Back row is a 28px target (prototype `.sback`: 6px 8px padding), taller than a 24px menu row: it is the one way out of Settings. */
export const SETTINGS_BACK_ROW_CLASS = 'mb-2.5 mt-0.5 h-7 max-md:h-[34px]';

export interface SettingsMenuRow {
  id: SettingsPageId;
  href: string;
  label: string;
  active: boolean;
  count?: SettingsNavCount;
}

export interface SettingsMenu {
  home: { href: string; active: boolean };
  tiers: Array<{ id: string; title: string; rows: SettingsMenuRow[] }>;
}

export function settingsMenu(
  ws: string,
  pathname: string,
  groups: SettingsNavGroup[],
  counts: Partial<Record<SettingsPageId, SettingsNavCount>>,
): SettingsMenu {
  const home = settingsHomeHref(ws);
  return {
    home: { href: home, active: pathname === home },
    tiers: groups.map((g) => ({
      id: g.id,
      title: g.title,
      rows: g.links.map((l) => ({
        id: l.id,
        href: l.href,
        label: l.label,
        active: isSettingsLinkActive(pathname, l),
        count: counts[l.id],
      })),
    })),
  };
}
