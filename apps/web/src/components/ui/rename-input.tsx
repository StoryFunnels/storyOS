'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { cn } from '@/lib/utils';

/**
 * #1301 — the ONE inline-rename input.
 *
 * Typing a Space into a space's rename input was swallowed. The input sits INSIDE a sortable row whose
 * dnd-kit `listeners` are spread on the row, and a keydown bubbles from the input up to the row's
 * `onKeyDown`. dnd-kit's KeyboardSensor treats Space as "pick up", and — because the row never registers
 * a separate activator node — it cannot tell the event came from a child, so it calls `preventDefault()`
 * on the Space. A prevented keydown inserts no character: "Client Work 2026" saved as "ClientWork2026".
 * (A database row dodged it only because its sortable is disabled while renaming; a space row and a
 * group header were not.) Nothing failed to compile and no test pressed a key.
 *
 * The rule: while a rename input has focus, the row, the drag sensors and any global hotkey do not see
 * its keys. ONLY Enter (commit) and Escape (cancel) leave the input, and they leave through `onDone`,
 * not by bubbling. Tab and blur are unchanged: blur still commits.
 *
 * `RENAME_INPUT_GUARDS` is the shared handler set. Anything that renders an inline rename `<input>` uses
 * `<RenameInput>` (or spreads the guards) — `rename-input.unit.test.ts` scans the source for stragglers.
 */

/** Stop an event reaching the row it is rendered inside (React tree: bubbles through portals too). */
function stop(e: SyntheticEvent) {
  e.stopPropagation();
}

/**
 * The pointer half: a mousedown/pointerdown/touchstart inside the input must not start a row drag
 * (the space row stays draggable while renaming, and a drag from inside the input also loses the
 * text selection). Clicks are NOT stopped.
 */
export const RENAME_INPUT_POINTER_GUARDS = {
  onPointerDown: stop,
  onMouseDown: stop,
  onTouchStart: stop,
} as const;

/** The key half: all three key events, so neither the activator (keydown) nor a keyup/keypress hotkey sees them. */
export const RENAME_INPUT_KEY_GUARDS = {
  onKeyUp: stop,
  onKeyPress: stop,
} as const;

/**
 * The keydown handler: every key stays in the input; Enter commits and Escape cancels.
 * Exported separately so a test can drive it with a plain event object.
 */
export function renameKeyDown(
  e: Pick<KeyboardEvent, 'key' | 'stopPropagation' | 'preventDefault'> & { nativeEvent?: { isComposing?: boolean } },
  { commit, cancel }: { commit: () => void; cancel: () => void },
) {
  e.stopPropagation();
  // An IME confirming a candidate sends Enter with isComposing: that is not a commit.
  if (e.nativeEvent?.isComposing) return;
  if (e.key === 'Enter') {
    commit();
  } else if (e.key === 'Escape') {
    cancel();
  }
}

export function RenameInput({
  initial,
  onDone,
  className,
  'aria-label': ariaLabel,
}: {
  initial: string;
  /** Called with the trimmed value on Enter/blur, and with `initial` on Escape. */
  onDone: (name: string) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const [value, setValue] = useState(initial);
  // Enter commits and then the input unmounts, which fires a blur: without this the commit would run twice.
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  // `autoFocus` alone is not enough: the Rename menu is still open (modal, focus-trapped) when this mounts, so the
  // focus call lands on nothing and `document.activeElement` ends up <body>. Focus again once the menu has closed.
  // (The menu's own focus RETURN to its trigger is turned off for Rename: see `onCloseAutoFocus` in `SidebarRowMenu`.)
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    const t = setTimeout(() => {
      if (el && document.activeElement !== el) el.focus();
    }, 50);
    return () => clearTimeout(t);
  }, []);
  return (
    <input
      ref={ref}
      autoFocus
      aria-label={ariaLabel ?? 'Name'}
      // #717 — plain `rounded` bypassed the radius token; --radius-control is the fix, not the `<Input>`
      // primitive (its `sm` size would also swap this compact px-1/py-0.5/border-strong treatment for a restyle).
      className={cn(
        'w-full rounded-[var(--radius-control)] border border-border-strong bg-card px-1 py-0.5 text-body text-ink',
        className,
      )}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim())}
      onKeyDown={(e) => renameKeyDown(e, { commit: () => finish(value.trim()), cancel: () => finish(initial) })}
      {...RENAME_INPUT_KEY_GUARDS}
      {...RENAME_INPUT_POINTER_GUARDS}
    />
  );
}
