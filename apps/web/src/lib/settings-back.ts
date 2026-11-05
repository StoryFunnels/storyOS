import { isSettingsPath } from '@/lib/settings-nav';

/**
 * "Back to <workspace>" in the Settings menu (ticket #1216): the last page the person was on OUTSIDE Settings, not browser history.
 *
 * History is the wrong source: moving between Settings pages stacks entries, so history-back lands on the previous settings page.
 * So a listener remembers each non-settings path as it is visited, and Back links to that.
 *
 * The rules, each a function so it can be tested:
 *  - a settings path is never remembered, so Back can never loop into Settings;
 *  - only a path inside THIS workspace counts (a stale value from another workspace is ignored);
 *  - nothing remembered (deep link straight into Settings, a fresh tab) falls back to the workspace home.
 * Storage is `sessionStorage`, per tab: it survives a reload of a settings page, and a new tab starts with no previous page.
 */
const KEY = (ws: string) => `storyos-settings-back:${ws}`;

export function workspaceHomeHref(ws: string): string {
  return `/w/${ws}`;
}

/** Whether `href` (path plus optional query) is a page of workspace `ws` that is not in Settings. */
export function isRememberablePath(ws: string, href: string | null | undefined): href is string {
  if (!href) return false;
  const path = href.split(/[?#]/)[0] ?? '';
  const home = workspaceHomeHref(ws);
  const inside = path === home || path.startsWith(`${home}/`);
  return inside && !isSettingsPath(path);
}

/** Where Back goes: the remembered page when it is valid for this workspace, otherwise the workspace home. */
export function settingsBackHref(ws: string, remembered: string | null | undefined): string {
  return isRememberablePath(ws, remembered) ? remembered : workspaceHomeHref(ws);
}

export function readRememberedPath(ws: string): string | null {
  try {
    return window.sessionStorage.getItem(KEY(ws));
  } catch {
    return null;
  }
}

/** Remember `href` as the place to go Back to, unless it is a settings page (or another workspace's). Returns whether it was stored. */
export function rememberOutsideSettings(ws: string, href: string): boolean {
  if (!isRememberablePath(ws, href)) return false;
  try {
    window.sessionStorage.setItem(KEY(ws), href);
    return true;
  } catch {
    return false;
  }
}
