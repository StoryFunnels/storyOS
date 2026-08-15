'use client';

import { Toaster } from 'sonner';
import type { CSSProperties } from 'react';

/**
 * #328 — the app's toasts on StoryOS design tokens instead of sonner's stock
 * white/black.
 *
 * Toasts had been mounted as a bare `<Toaster position="bottom-right" />`, so
 * they rendered in sonner's own palette: a white card with black text in a
 * product whose surfaces are warm off-white in light mode and near-navy in
 * dark. In dark mode the mismatch is glaring — a white slab over a dark app.
 *
 * This matters more than ordinary polish because of #265: the Undo affordance
 * on a destructive action lives IN a toast. A toast that reads as a foreign
 * overlay is one a user dismisses without reading, and the thing they dismiss
 * is their only route back from a delete. Hence the action button is styled
 * as a real accent control here, not left as sonner's default chip.
 *
 * Driven through sonner's own per-type CSS variables rather than `classNames`
 * + `unstyled`, deliberately: we restyle only colour and shape and inherit
 * sonner's layout, stacking, swipe and animation behaviour untouched. Because
 * the values are `var(--…)` token references and the tokens flip with the
 * theme, dark mode needs no second declaration here.
 */
export function StoryOSToaster() {
  return (
    <Toaster
      position="bottom-right"
      // The tokens already carry the theme; sonner's own light/dark switch
      // would fight them.
      theme="light"
      toastOptions={{
        style: {
          borderRadius: 'var(--radius-card)',
          // Matches the app's elevated surfaces (dialogs, popovers) rather
          // than sonner's heavier default drop shadow.
          boxShadow: '0 4px 16px rgb(15 23 41 / 0.12)',
          fontSize: '13px',
        },
        classNames: {
          // #265's Undo. It has to look pressable at a glance — this is the
          // only route back from a destructive action, and it is on a timer.
          actionButton:
            '!bg-[var(--accent)] !text-[var(--primary)] !font-medium !rounded-[var(--radius-control)]',
          cancelButton: '!bg-[var(--bg-hover)] !text-[var(--text-muted)]',
          description: '!text-[var(--text-muted)]',
        },
      }}
      style={
        {
          // Neutral toasts read as a normal elevated card.
          '--normal-bg': 'var(--bg-card)',
          '--normal-text': 'var(--text-primary)',
          '--normal-border': 'var(--border-default)',
          // Status toasts keep the card surface and carry their meaning in the
          // icon + border, not a saturated fill — a solid green/red slab would
          // be louder than anything else in the UI.
          '--success-bg': 'var(--bg-card)',
          '--success-text': 'var(--text-primary)',
          '--success-border': 'var(--success)',
          '--error-bg': 'var(--bg-card)',
          '--error-text': 'var(--text-primary)',
          '--error-border': 'var(--error)',
          '--warning-bg': 'var(--bg-card)',
          '--warning-text': 'var(--text-primary)',
          '--warning-border': 'var(--warning)',
          '--info-bg': 'var(--bg-card)',
          '--info-text': 'var(--text-primary)',
          '--info-border': 'var(--info)',
        } as CSSProperties
      }
    />
  );
}
