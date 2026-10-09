'use client';

import { useEffect, useRef } from 'react';
import { isTypingTarget } from './shortcuts';

/**
 * #834 — Esc closes the open RECORD, but only after every layer above it has had its Esc.
 *
 * Esc already means "step back one layer" all over this product: a popover, a menu, the
 * @/# picker, a dialog, an inline edit, the ⌘K palette, a grid selection. The record is the
 * OUTERMOST layer, so it may only take an Esc that nothing nearer claimed. Closing a whole
 * record because someone pressed Esc to dismiss a dropdown would be worse than the gap
 * this fixes, so every rule below errs toward doing nothing.
 *
 * Three independent signals, any one of which means "not mine":
 *   1. The key arrived while typing (input / textarea / select / a contenteditable such as
 *      the rich-text editor). Esc there belongs to that control, and ending an edit is
 *      never allowed to ALSO leave the page. The target is read at keydown time, so an
 *      inline editor that unmounts itself on Esc still counts as having been typing.
 *   2. A layer was OPEN when the key went down (`hasOpenLayer`). Snapshotted in the capture
 *      phase, before any handler can close it, so a layer that closes itself without
 *      claiming the event is still recognised.
 *   3. Some handler claimed the event (`defaultPrevented`). Radix dismissable layers do
 *      this when they close; the hand-rolled ones in this app now do too. Read AFTER the
 *      whole dispatch, which is why the decision is deferred one task.
 */

export type EscapeSnapshot = {
  key: string;
  defaultPrevented: boolean;
  typing: boolean;
  /** The key was typed into a rich-text editor (contenteditable) rather than a plain input. */
  inEditor: boolean;
  layerOpen: boolean;
  modifier: boolean;
  composing: boolean;
  repeat: boolean;
};

/**
 * Pure: what should this Escape do? Exported so the rule is tested, not asserted.
 *
 *   'close' — nothing nearer wants it: the record closes.
 *   'blur'  — it was typed into a rich-text editor and no picker/menu is open: the editor
 *             lets go of focus, and the NEXT Esc closes the record. An editor is a layer
 *             too, and it is the one layer that holds unsaved typing — so Esc never closes
 *             the record out from under it in the same keystroke.
 *   'none'  — somebody else owns this Esc.
 *
 * A plain input is NOT blurred here: those end their own edit on Esc (commit or cancel, as
 * they always did) and unmount, which is what makes the following Esc a 'close'.
 */
export function escapeAction(s: EscapeSnapshot): 'close' | 'blur' | 'none' {
  if (s.key !== 'Escape') return 'none';
  if (s.modifier || s.composing || s.repeat) return 'none';
  if (s.defaultPrevented || s.layerOpen) return 'none';
  if (s.inEditor) return 'blur';
  if (s.typing) return 'none';
  return 'close';
}

export function shouldCloseOnEscape(s: EscapeSnapshot): boolean {
  return escapeAction(s) === 'close';
}

/** A rich-text editor surface (BlockNote / ProseMirror), as opposed to a plain input. */
export function isEditorTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && el.tagName && el.isContentEditable);
}

/**
 * Every kind of overlay this app draws, by what it leaves in the DOM while OPEN:
 *   - dialogs and the ⌘K palette: role=dialog / aria-modal
 *   - Radix menus, popovers, selects, tooltips: a popper wrapper, unmounted when closed
 *   - listboxes / menus without Radix: their ARIA role
 * Deliberately NOT `[aria-expanded="true"]`: collapsible sections and expanded sidebar
 * spaces carry it permanently, and Esc would never work.
 */
export const OPEN_LAYER_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-menu-content]',
].join(',');

export function hasOpenLayer(doc: Pick<Document, 'querySelector'> = document): boolean {
  return doc.querySelector(OPEN_LAYER_SELECTOR) !== null;
}

/**
 * Calls `onEscape` when an Escape keystroke reaches the top of the stack unclaimed.
 * One listener per mounted caller; the caller decides WHAT closing means.
 */
export function useEscapeToClose(onEscape: () => void, enabled = true) {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Snapshot now, in the capture phase — before anything has had the chance to close
      // the layer or unmount the input this key was typed into.
      const snap = {
        key: e.key,
        typing: isTypingTarget(e.target),
        inEditor: isEditorTarget(e.target),
        layerOpen: hasOpenLayer(),
        modifier: e.metaKey || e.ctrlKey || e.altKey || e.shiftKey,
        composing: e.isComposing,
        repeat: e.repeat,
      };
      const target = e.target as HTMLElement | null;
      // Decide after the whole dispatch, so `defaultPrevented` reflects every handler.
      setTimeout(() => {
        const action = escapeAction({ ...snap, defaultPrevented: e.defaultPrevented });
        if (action === 'close') handler.current();
        else if (action === 'blur') target?.blur();
      }, 0);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
