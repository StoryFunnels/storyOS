'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Collapse state for a long section on the record page (#309).
 *
 * Scoped per DATABASE + section, not per record: "Acceptance Criteria is noise to
 * me on Issues" is a standing preference, and re-folding the same field on every
 * record would make the feature worthless. (The ticket first said per-record;
 * per-database is the better read of the need — noted in the PR.)
 *
 * Stored in localStorage, deliberately: it is a per-viewer display preference. It
 * must NOT go in the view/record config, where one user's folding would hide
 * content for everyone else.
 */
function storageKey(db: string, section: string): string {
  return `storyos:collapsed:${db}:${section}`;
}

export function useCollapsedSection(db: string, section: string) {
  // Always start expanded so server and first client render agree; the stored
  // value is applied in an effect. Reading localStorage during render would
  // hydrate-mismatch (server has no localStorage).
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(storageKey(db, section)) === '1');
    } catch {
      // Private mode / storage disabled — collapsing still works for this session.
    }
  }, [db, section]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        if (next) window.localStorage.setItem(storageKey(db, section), '1');
        else window.localStorage.removeItem(storageKey(db, section));
      } catch {
        /* not fatal — the toggle still applies in-memory */
      }
      return next;
    });
  }, [db, section]);

  return { collapsed, toggle };
}

/** The chevron itself — a real button, so it's keyboard reachable and announced. */
export function CollapseToggle({
  collapsed,
  onToggle,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
    >
      <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-90')} />
    </button>
  );
}

/**
 * Wrapper for the collapsible body.
 *
 * **Hides with CSS — it never unmounts the child.** A BlockNote editor holds
 * unsaved local edits (this page debounces commits by 800ms), so unmounting on
 * collapse could discard what someone just typed. `hidden` keeps the editor alive
 * and its state intact.
 */
export function CollapsibleBody({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: React.ReactNode;
}) {
  return <div hidden={collapsed}>{children}</div>;
}
