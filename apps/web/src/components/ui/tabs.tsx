import { useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Ticket #1277 item 6 — a real tab strip (role=tablist), for the record peek's Details / Comments.
 *
 * `Segmented` is a radiogroup on purpose (one choice among options); this is the other control: a strip whose selection swaps a
 * PANEL, so it carries tab semantics: each tab names the panel it controls (`aria-controls`), roving tabindex makes the strip one tab
 * stop, and the arrow keys, Home and End move AND activate (automatic activation, the pattern for two cheap panels).
 */
export interface TabOption<T extends string> {
  value: T;
  label: string;
}

/** The index a key moves to inside a strip of `count` tabs, or null for a key the strip does not handle. Wraps at both ends. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count < 1) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export const tabId = (idBase: string, value: string) => `${idBase}-tab-${value}`;
export const tabPanelId = (idBase: string, value: string) => `${idBase}-panel-${value}`;

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
  idBase,
  className,
}: {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the strip for screen readers. */
  label: string;
  /** Prefix for the tab and panel ids, unique on the page; the panel uses `tabPanelId(idBase, value)`. */
  idBase: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function onKeyDown(e: React.KeyboardEvent) {
    const at = options.findIndex((o) => o.value === value);
    const to = nextTabIndex(e.key, at < 0 ? 0 : at, options.length);
    if (to === null) return;
    const next = options[to];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    });
  }

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('flex items-center gap-4 border-b border-border-default px-[26px]', className)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            id={tabId(idBase, o.value)}
            aria-selected={selected}
            aria-controls={tabPanelId(idBase, o.value)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              '-mb-px cursor-pointer border-b-2 py-2 text-body transition-colors',
              selected ? 'border-ink font-semibold text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
