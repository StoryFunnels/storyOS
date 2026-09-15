'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Appearance preference (#30). 'system' follows the OS; the other two pin it.
 * Appearance is per-browser (localStorage), not stored on the account. */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'storyos-theme';

/**
 * #711 phase 0 — an embedded public form does NOT follow the visitor's OS.
 *
 * It is a component of somebody else's page, and that page decides what it
 * looks like. Left to follow the visitor, a form on a warm cream careers page
 * renders as a dark navy card with a blue button for any applicant whose laptop
 * is in dark mode (--bg-card #171c26, --primary #35427a: the two values in the
 * reported screenshot) while looking perfect to the customer who embedded it.
 *
 * This has to be decided at <html>, not on the form's own wrapper. In embed
 * mode the wrapper is bare `p-4` with no background of its own, so scoping the
 * light palette to it still leaves the BODY painting --bg-app dark: a light
 * card in a dark frame, which is not an improvement. Measured, not assumed.
 *
 * Detection is deliberately URL-only so the pre-paint script and the provider
 * can agree without either importing React state.
 */
export function isEmbeddedForm(pathname: string, search: string): boolean {
  return /^\/f\//.test(pathname) && new URLSearchParams(search).get('embed') === '1';
}

/** The pre-paint script (see layout.tsx) sets <html data-theme> before React hydrates,
 * so there's no flash. Keep this logic in sync with that inline script — and with
 * `isEmbeddedForm` above, whose logic the first two statements mirror. */
export const THEME_INIT_SCRIPT = `(function(){try{if(/^\\/f\\//.test(location.pathname)&&new URLSearchParams(location.search).get('embed')==='1'){document.documentElement.setAttribute('data-theme','light');return;}var t=localStorage.getItem('${THEME_STORAGE_KEY}')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var r=(t==='dark'||(t==='system'&&m))?'dark':'light';document.documentElement.setAttribute('data-theme',r);}catch(e){}})();`;

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === 'dark' || (pref === 'system' && systemPrefersDark()) ? 'dark' : 'light';
}

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('light');

  const apply = useCallback((pref: ThemePreference) => {
    // #711 phase 0 — an embedded form is pinned light and stays pinned. Without
    // this the guard in THEME_INIT_SCRIPT would hold only until hydration: the
    // mount effect below re-applies the visitor's own preference to the SAME
    // attribute, so the form would paint light and then flip to dark.
    const r =
      isEmbeddedForm(window.location.pathname, window.location.search) ? 'light' : resolve(pref);
    document.documentElement.setAttribute('data-theme', r);
    setResolved(r);
  }, []);

  // #511 — this must call apply(), not just setResolved(). The pre-paint script
  // (THEME_INIT_SCRIPT) sets the DOM attribute before hydration so there's no
  // flash, and this effect used to assume that already happened and only
  // synced React state to match. When the script doesn't end up applying the
  // attribute (reproduced live, script present in <head>), state and DOM
  // permanently disagree: every CSS-driven surface reads the DOM attribute and
  // stays light, while the handful of components that read the React context
  // directly (BlockNoteView's theme prop) go dark — a broken-looking split on
  // the very first render. Calling apply() here makes the DOM write the ONE
  // thing this effect does, self-healing regardless of whether the pre-paint
  // script fired, rather than adding a second writer for the same value.
  useEffect(() => {
    const stored = (localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null) ?? 'system';
    setPreferenceState(stored);
    apply(stored);
  }, [apply]);

  const setPreference = useCallback(
    (p: ThemePreference) => {
      localStorage.setItem(THEME_STORAGE_KEY, p);
      setPreferenceState(p);
      apply(p);
    },
    [apply],
  );

  // When following the system and it flips, re-resolve live.
  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference, apply]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
