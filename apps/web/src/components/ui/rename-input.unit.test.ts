import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { KeyboardSensor } from '@dnd-kit/core';
import { describe, expect, it, vi } from 'vitest';
import { isTypingTarget } from '@/lib/shortcuts';
import { EditableSafeKeyboardSensor } from './drag-presentation';
import { renameKeyDown, RENAME_INPUT_KEY_GUARDS, RENAME_INPUT_POINTER_GUARDS } from './rename-input';

/**
 * #1301 — a Space typed into an inline rename input was swallowed: dnd-kit's KeyboardSensor (on the sortable row the input
 * lives in) treats Space as "pick up" and preventDefault()s it. These drive the real handlers with plain event objects and
 * scan the source so a new rename input cannot skip the shared guard.
 */
const SRC = join(__dirname, '..', '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '.next' ? [] : files(p);
    return /\.tsx$/.test(n) ? [p] : [];
  });
}
const all = files(SRC).map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));

function keyEvent(key: string, extra: Record<string, unknown> = {}) {
  return { key, stopPropagation: vi.fn(), preventDefault: vi.fn(), ...extra };
}

describe('the rename input keeps every key to itself; only Enter and Escape leave it (#1301)', () => {
  const KEYS = ['a', 'Z', '2', ' ', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete', 'Tab', '/'];

  it.each(KEYS)('%j: stays in the input (never reaches the row), does not commit or cancel, and is not preventDefault()ed', (key) => {
    const e = keyEvent(key);
    const commit = vi.fn();
    const cancel = vi.fn();
    renameKeyDown(e, { commit, cancel });
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('Enter commits and Escape cancels, each exactly once', () => {
    const commit = vi.fn();
    const cancel = vi.fn();
    renameKeyDown(keyEvent('Enter'), { commit, cancel });
    expect([commit.mock.calls.length, cancel.mock.calls.length]).toEqual([1, 0]);
    renameKeyDown(keyEvent('Escape'), { commit, cancel });
    expect([commit.mock.calls.length, cancel.mock.calls.length]).toEqual([1, 1]);
  });

  it('an IME confirming a candidate (Enter while composing) is not a commit', () => {
    const commit = vi.fn();
    renameKeyDown(keyEvent('Enter', { nativeEvent: { isComposing: true } }), { commit, cancel: vi.fn() });
    expect(commit).not.toHaveBeenCalled();
  });

  it('keyup, keypress and every pointer-down flavour are stopped too (no row drag from inside the input); click is not', () => {
    for (const h of [...Object.values(RENAME_INPUT_KEY_GUARDS), ...Object.values(RENAME_INPUT_POINTER_GUARDS)]) {
      const e = { stopPropagation: vi.fn() };
      h(e as never);
      expect(e.stopPropagation).toHaveBeenCalled();
    }
    expect(Object.keys(RENAME_INPUT_POINTER_GUARDS)).not.toContain('onClick');
  });
});

describe('the drag sensor ignores keys typed into a field, and still lifts a row on Space (#1301)', () => {
  const baseHandler = KeyboardSensor.activators[0]!.handler;
  const guarded = EditableSafeKeyboardSensor.activators[0]!.handler;
  const options = { keyboardCodes: { start: ['Space', 'Enter'], cancel: ['Escape'], end: ['Space', 'Enter'] } };
  const row = {};
  const ctx = { active: { activatorNode: { current: null } } } as never;
  const spaceFrom = (target: unknown) => {
    // dnd-kit reads `code`/`target` off the native event but calls preventDefault on the React event it was handed.
    const native = { code: 'Space', target };
    const react = { nativeEvent: native, ...native, preventDefault: vi.fn() };
    return { native: react, event: react as never };
  };

  it('ROOT CAUSE, stock dnd-kit: Space bubbling from a child input is preventDefault()ed (this is the swallowed space)', () => {
    const { native, event } = spaceFrom({ tagName: 'INPUT' });
    baseHandler(event, { ...options, onActivation: vi.fn() } as never, ctx);
    expect(native.preventDefault).toHaveBeenCalled();
  });

  it('guarded: the same Space from an INPUT / TEXTAREA / SELECT / contentEditable is left alone', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      const { native, event } = spaceFrom(target);
      const onActivation = vi.fn();
      expect(guarded(event, { ...options, onActivation } as never, ctx)).toBe(false);
      expect(native.preventDefault).not.toHaveBeenCalled();
      expect(onActivation).not.toHaveBeenCalled();
    }
  });

  it('guarded: Space on the row itself STILL picks it up (keyboard drag is not broken)', () => {
    const { native, event } = spaceFrom({ tagName: 'DIV', ...row });
    const onActivation = vi.fn();
    expect(guarded(event, { ...options, onActivation } as never, ctx)).toBe(true);
    expect(native.preventDefault).toHaveBeenCalled();
    expect(onActivation).toHaveBeenCalled();
  });

  it('isTypingTarget: a button or a div is not a typing target; null is not', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' } as never)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV' } as never)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('every inline rename input in src uses the shared guard (#1301)', () => {
  // An inline rename input = a text <input> whose commit is a blur or Enter inside a row/header, found by what it DOES
  // (RenameInput, or the sidebar's name prompt), not by a filename. The set is derived: any file importing the shared module.
  const users = all.filter((f) => /from '@\/components\/ui\/rename-input'/.test(f.text));

  it('the sidebar uses <RenameInput> for the space, database and group rows and no longer defines its own', () => {
    const sidebar = all.find((f) => f.rel === 'components/sidebar.tsx')!.text;
    expect(sidebar).not.toMatch(/function RenameInline/);
    expect(sidebar).not.toMatch(/<RenameInline/);
    expect((sidebar.match(/<RenameInput\b/g) ?? []).length).toBe(3);
  });

  it('the sidebar name prompt (document / view / folder rename dialog) spreads the same guards', () => {
    const sidebar = all.find((f) => f.rel === 'components/sidebar.tsx')!.text;
    expect(sidebar).toMatch(/renameKeyDown\(e, \{ commit: confirm, cancel: onClose \}\)/);
    expect(sidebar).toContain('{...RENAME_INPUT_KEY_GUARDS}');
    expect(sidebar).toContain('{...RENAME_INPUT_POINTER_GUARDS}');
  });

  it('no sidebar file hand-rolls a rename input: every <input> that commits on Enter/blur there goes through the shared module', () => {
    const offenders = all
      .filter((f) => /^components\/sidebar[^/]*\.tsx$/.test(f.rel))
      .filter((f) => /<input\b[\s\S]{0,600}?(onBlur|e\.key === 'Enter')/.test(f.text) && !/rename-input/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it('every sortable-sensor hook uses the editable-safe keyboard sensor, never the stock one', () => {
    const drag = all.find((f) => f.rel === 'components/ui/drag-presentation.tsx')!.text;
    expect(drag).not.toMatch(/useSensor\(KeyboardSensor/);
    expect((drag.match(/useSensor\(EditableSafeKeyboardSensor/g) ?? []).length).toBe(2);
    const stray = all.filter((f) => f.rel !== 'components/ui/drag-presentation.tsx' && /useSensor\(KeyboardSensor/.test(f.text)).map((f) => f.rel);
    expect(stray).toEqual([]);
  });

  it("the Rename menu items opt out of the menu's focus return (it stole focus from the input and its blur committed the rename)", () => {
    const sidebar = all.find((f) => f.rel === 'components/sidebar.tsx')!.text;
    expect((sidebar.match(/opensInlineInput: true/g) ?? []).length).toBe(2);
    expect(sidebar).toContain('renameChosen.current = true');
    const menu = all.find((f) => f.rel === 'components/sidebar-row-menu.tsx')!.text;
    expect(menu).toContain('onCloseAutoFocus');
  });
});
