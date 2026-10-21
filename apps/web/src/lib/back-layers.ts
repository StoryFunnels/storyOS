'use client';

import { useEffect, useRef } from 'react';
import { GUARD_KEY, installHistoryTracking, isGuardState, traversed } from './nav-trail';
import type { Traversal } from './nav-trail';

/**
 * #962 — an OVERLAY is closed by Back before anything else.
 *
 * On a phone the back gesture used to navigate away from underneath an open drawer, sheet,
 * dialog or ⌘K palette, leaving the overlay floating over the wrong page. Esc already
 * closed them; Back and the gesture now do the same, through the same dismissals.
 *
 * How, in one paragraph: while at least one layer is open, the current history entry is a
 * GUARD — a copy of the page's own entry, pushed when the first layer opens. Back from the
 * guard lands on the page's real entry, which is the signal: the topmost layer is
 * dismissed and the person is still on the page. If more layers remain, a guard goes back
 * up so the next Back closes the next one.
 *
 * What it deliberately does NOT do is pop the guard when a layer closes some other way
 * (Esc, a click outside, a menu item that navigates). `history.back()` is asynchronous, so
 * doing it right after `router.push` can undo the navigation it raced. Instead a guard
 * with no layer open is TRANSPARENT: arriving on one, in either direction, steps straight
 * on. The cost is one extra history entry on a page where an overlay was ever used; the
 * next overlay on that page reuses it.
 */

export interface BackLayersEnv {
  /** The current history entry is a guard. */
  onGuard: () => boolean;
  /** Push a guard entry at the current URL. */
  pushGuard: () => void;
  /** Move through history one entry. */
  step: (dir: 'back' | 'forward') => void;
  schedule: (fn: () => void, ms: number) => void;
}

/** How long a layer gets to close itself after being asked to, before Back is allowed to
 *  go through instead. A layer that ignores its dismissal must not become a trap. */
export const DISMISS_GRACE_MS = 150;
const PASS_WINDOW_MS = 400;

export function createBackLayers(env: BackLayersEnv) {
  interface Layer {
    dismiss: () => void;
  }
  const layers: Layer[] = [];
  /** We stepped over a guard and the traversal we caused has not landed yet: the entry it lands on is the page
   *  the person was heading to, not another guard to skip. Expires, because a step with nothing beyond it (a
   *  Forward past the last entry) never lands. */
  let passing = false;
  const pass = (dir: 'back' | 'forward') => {
    passing = true;
    env.schedule(() => (passing = false), PASS_WINDOW_MS);
    env.step(dir);
  };

  /** Returns the unregister function. */
  function register(dismiss: () => void): () => void {
    const layer: Layer = { dismiss };
    layers.push(layer);
    if (!env.onGuard()) env.pushGuard();
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
  }

  function onPopState(t: Traversal): void {
    if (layers.length > 0) {
      // Back, from the guard, onto the page's real entry: that Back belongs to the layer.
      if (t.dir === 'back' && t.leftGuard && !t.onGuard) {
        const before = layers.length;
        layers[layers.length - 1]!.dismiss();
        env.schedule(() => {
          if (layers.length === 0) return;
          if (layers.length < before) {
            // One closed, others remain: put the guard back for the next Back.
            if (!env.onGuard()) env.pushGuard();
          } else {
            // It ignored the dismissal. Back goes through rather than doing nothing.
            env.step('back');
          }
        }, DISMISS_GRACE_MS);
      }
      return;
    }
    // No layer open: a guard is invisible to the person, so step over it.
    if (t.dir === 'none') return;
    if (t.onGuard) return pass(t.dir); // however many guards in a row
    if (passing) {
      passing = false; // landed on the page beyond the guard
      return;
    }
    // Back from a guard we were SITTING on (a layer closed under us) lands on the page's own entry, which is the
    // page the person is already looking at: go one further.
    if (t.leftGuard && t.dir === 'back') pass('back');
  }

  return { register, onPopState, size: () => layers.length };
}

/** A synthetic Escape — the one dismissal every Radix layer already answers, so a layer
 *  needs no code of its own to take part. */
function dispatchEscape(): void {
  const target: Element = document.activeElement ?? document.body;
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }),
  );
}

let controller: ReturnType<typeof createBackLayers> | null = null;

function shared() {
  if (controller) return controller;
  installHistoryTracking();
  controller = createBackLayers({
    onGuard: () => isGuardState(window.history.state),
    pushGuard: () => {
      const state = window.history.state;
      const base = state !== null && typeof state === 'object' ? (state as Record<string, unknown>) : {};
      window.history.pushState({ ...base, [GUARD_KEY]: true }, '');
    },
    step: (dir) => (dir === 'back' ? window.history.back() : window.history.forward()),
    schedule: (fn, ms) => void setTimeout(fn, ms),
  });
  window.addEventListener('popstate', () => controller!.onPopState(traversed()));
  return controller;
}

/**
 * Marks a layer as open for as long as `active` holds. `dismiss` is what Back does to it;
 * it defaults to Escape, which is right for anything Radix draws. Hand-rolled layers (the
 * mobile drawer, ⌘K, the Tyron panel) pass their own close.
 */
export function useBackLayer(active = true, dismiss?: () => void): void {
  const latest = useRef(dismiss);
  useEffect(() => {
    latest.current = dismiss;
  });
  useEffect(() => {
    if (!active) return;
    return shared().register(() => (latest.current ?? dispatchEscape)());
  }, [active]);
}

/** `useBackLayer` as a component, for the inside of a layer's content: it mounts exactly
 *  while the content does, so a Radix `Content` needs no open-state plumbing. */
export function BackLayer({ dismiss }: { dismiss?: () => void }) {
  useBackLayer(true, dismiss);
  return null;
}
