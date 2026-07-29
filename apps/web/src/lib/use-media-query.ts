'use client';

import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Returns false on the server / first render
 * (no `window`), then settles to the real value after mount — callers that gate
 * a purely additive, post-hydration interaction (e.g. the split-screen panel,
 * #146) are unaffected by the initial false. Mirrors the breakpoint discipline
 * the app shell / record page already use (`md`, `lg`).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
