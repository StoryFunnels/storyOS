'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Appearance preference (#30). 'system' follows the OS; the other two pin it.
 * Appearance is per-browser (localStorage), not stored on the account. */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'storyos-theme';

/** The pre-paint script (see layout.tsx) sets <html data-theme> before React hydrates,
 * so there's no flash. Keep this logic in sync with that inline script. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var r=(t==='dark'||(t==='system'&&m))?'dark':'light';document.documentElement.setAttribute('data-theme',r);}catch(e){}})();`;

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

  // Adopt the value the pre-paint script already applied, so state matches the DOM.
  useEffect(() => {
    const stored = (localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null) ?? 'system';
    setPreferenceState(stored);
    setResolved(resolve(stored));
  }, []);

  const apply = useCallback((pref: ThemePreference) => {
    const r = resolve(pref);
    document.documentElement.setAttribute('data-theme', r);
    setResolved(r);
  }, []);

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
