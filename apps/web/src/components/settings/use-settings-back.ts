'use client';

import { useEffect, useState } from 'react';
import { readRememberedPath, rememberOutsideSettings, settingsBackHref, workspaceHomeHref } from '@/lib/settings-back';

/**
 * The route listener behind "Back to <workspace>" (ticket #1216). Mounted once, in the workspace shell, so it sees every page
 * visited, not just Settings: it records the current page whenever it is outside Settings (`rememberOutsideSettings` refuses a
 * settings path). The query string is read from `window.location` inside the effect, which runs after the navigation has committed.
 */
export function useRememberOutsideSettings(ws: string, pathname: string | null) {
  useEffect(() => {
    if (!pathname) return;
    rememberOutsideSettings(ws, `${pathname}${window.location.search}`);
  }, [ws, pathname]);
}

/** Where Back goes now. The workspace home on the first render (the server cannot read sessionStorage), the remembered page after. */
export function useSettingsBackHref(ws: string): string {
  const [href, setHref] = useState(workspaceHomeHref(ws));
  useEffect(() => {
    setHref(settingsBackHref(ws, readRememberedPath(ws)));
  }, [ws]);
  return href;
}
