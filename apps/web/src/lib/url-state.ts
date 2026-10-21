'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * #962 — page state that belongs in the URL, with the history rule built in.
 *
 *   - a PLACE (the selected run, a record) is written with 'push': it gets a Back step and a link;
 *   - an EDIT of what the page shows (a search, a status filter) is written with 'replace': Back never "undoes a
 *     search", and the search is still in the URL when Back returns to the page.
 *
 * An empty value removes the parameter, so a cleared search leaves a clean URL.
 */
export function useUrlParam(name: string): [string, (value: string, how: 'push' | 'replace') => void] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = params.get(name) ?? '';
  const set = useCallback(
    (next: string, how: 'push' | 'replace') => {
      const sp = new URLSearchParams(window.location.search);
      if (next) sp.set(name, next);
      else sp.delete(name);
      const qs = sp.toString();
      const href = `${pathname}${qs ? `?${qs}` : ''}`;
      if (how === 'push') router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [name, pathname, router],
  );
  return [value, set];
}
