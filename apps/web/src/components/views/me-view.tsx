'use client';

import { useSyncExternalStore } from 'react';
import { Users } from 'lucide-react';
import { inferStateCategory, isFinishedStateCategory } from '@storyos/schemas';
import { useDismissedHints } from '@/lib/dismissed-hints';
import type { Field } from '@/components/table-view/use-table-data';
import type { FilterCondition } from './filter-config';

/**
 * #928 — what a freshly made "Assigned to me" view says about itself, and the "not done" half of what it filters.
 */

/** "…and not done": the first workflow field's finished options (state category completed or canceled, ticket #1014 /
 *  #1017), as one `is none of`. Empty when there is no workflow field or none of its options is finished. */
export function notDoneConditions(fields: Field[]): FilterCondition[] {
  const workflow = fields.find((f) => f.type === 'workflow');
  const finished = (workflow?.options ?? [])
    .filter((o) => isFinishedStateCategory(o.category ?? inferStateCategory(o.label)))
    .map((o) => o.id);
  return workflow && finished.length > 0 ? [{ field: workflow.apiName, op: 'has_none', value: finished }] : [];
}

// ── "Said once, right after creating it" ──────────────────────────────────────────────────────────────────
// The line appears only for a view made THIS session by the tile (the author is the person who could expect
// teammates to see the same list), and never again once dismissed. Dismissal is per viewer and per view, stored as
// #986's dismissed_hints so it follows the person across devices. The in-memory set is the "right after creating
// it": a reload, or a teammate opening the view, does not bring it back.
const fresh = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function markFreshMeView(viewId: string): void {
  fresh.add(viewId);
  emit();
}

export const meHintId = (viewId: string) => `me-view:${viewId}`;

export const ME_HINT_TEXT =
  'Each teammate sees their own records here — this view shows whoever opens it what’s assigned to them.';

export function MeViewHint({ ws, viewId }: { ws: string; viewId: string | undefined }) {
  const isFresh = useSyncExternalStore(
    subscribe,
    () => (viewId ? fresh.has(viewId) : false),
    () => false,
  );
  const hints = useDismissedHints(ws);
  // `isDismissed` is undefined while loading: never flash the line open for someone who already hid it.
  if (!viewId || !isFresh || hints.isDismissed(meHintId(viewId)) !== false) return null;
  return (
    <div className="mx-4 mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--primary)_18%,var(--border-default))] bg-[color-mix(in_srgb,var(--primary)_7%,var(--bg-card))] px-2.5 py-[7px] text-label leading-[normal]! text-ink">
      <Users className="h-[13px] w-[13px] shrink-0 text-primary-text" aria-hidden />
      <span className="flex-1">{ME_HINT_TEXT}</span>
      <button
        type="button"
        className="shrink-0 p-0 text-label leading-[normal]! text-primary-text hover:underline"
        onClick={() => {
          hints.setDismissed(meHintId(viewId), true);
          fresh.delete(viewId);
          emit();
        }}
      >
        Got it
      </button>
    </div>
  );
}
