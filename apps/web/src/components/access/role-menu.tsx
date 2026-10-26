'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { GRANT_ROLE_ORDER, ROLE_WORDS } from '@/lib/access-model';
import type { GrantRole } from '@/lib/access-model';

/**
 * #924 — the role picker: a custom popover, never a native select (the design's ruling). It is the app's own Popover, which
 * becomes a bottom sheet on a phone by itself. A check marks the current role; below a separator, a red "Remove access".
 */
export function RoleMenu({
  role,
  onChange,
  onRemove,
  label,
  disabled,
}: {
  role: GrantRole;
  onChange: (role: GrantRole) => void;
  onRemove?: () => void;
  /** Who this is for, so the button has a name a screen reader can read. */
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    // `modal`: this menu lives inside a modal Dialog, whose `body { pointer-events: none }` lock reaches a plain popover's portal
    // (a sibling of the dialog's own branch), so its items never received a click (#729 found the same in another dialog). A modal
    // popover takes over the lock for itself while open.
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Role of ${label}: ${ROLE_WORDS[role].label}`}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2 text-label font-medium text-ink hover:bg-hover disabled:opacity-50 max-md:h-10 max-md:px-3"
        >
          {ROLE_WORDS[role].label}
          <ChevronDown className="h-3 w-3 text-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <ul role="menu" className="flex flex-col">
          {GRANT_ROLE_ORDER.map((r) => (
            <li key={r} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={r === role}
                onClick={() => {
                  setOpen(false);
                  if (r !== role) onChange(r);
                }}
                className="flex w-full items-start gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left hover:bg-hover max-md:py-2.5"
              >
                <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', r === role ? 'text-ink' : 'opacity-0')} aria-hidden />
                <span className="flex flex-col">
                  <span className="text-body font-medium text-ink">{ROLE_WORDS[r].label}</span>
                  <span className="text-label text-muted">{ROLE_WORDS[r].hint}</span>
                </span>
              </button>
            </li>
          ))}
          {onRemove && (
            <>
              <li role="separator" className="my-1 h-px bg-border-default" />
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onRemove();
                  }}
                  className="w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left text-body font-medium text-error hover:bg-hover max-md:py-2.5"
                >
                  Remove access
                </button>
              </li>
            </>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
