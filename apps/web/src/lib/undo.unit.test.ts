import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUndo, pushUndo, runLastUndo, shouldHandleUndoShortcut, undoDepth } from './undo';

beforeEach(() => clearUndo());

describe('the undo stack (#265)', () => {
  it('returns null when there is nothing to undo', async () => {
    expect(await runLastUndo()).toBeNull();
  });

  it('runs the most recent entry first and reports its label', async () => {
    const order: string[] = [];
    pushUndo({ label: 'first', run: async () => void order.push('first') });
    pushUndo({ label: 'second', run: async () => void order.push('second') });

    expect(await runLastUndo()).toEqual({ label: 'second' });
    expect(await runLastUndo()).toEqual({ label: 'first' });
    expect(order).toEqual(['second', 'first']);
  });

  it('pops the entry so a second press cannot re-run it', async () => {
    const run = vi.fn(async () => {});
    pushUndo({ label: 'once', run });

    await runLastUndo();
    await runLastUndo();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not push a failed entry back — a retry loop would just fail again', async () => {
    pushUndo({ label: 'doomed', run: async () => { throw new Error('already restored'); } });

    await expect(runLastUndo()).rejects.toThrow('already restored');
    expect(undoDepth()).toBe(0);
    expect(await runLastUndo()).toBeNull();
  });

  it('caps depth, dropping the OLDEST entries', async () => {
    for (let i = 0; i < 40; i++) pushUndo({ label: `e${i}`, run: async () => {} });
    expect(undoDepth()).toBe(25);
    // The newest survives; the oldest were shifted off.
    expect(await runLastUndo()).toEqual({ label: 'e39' });
  });
});

/**
 * The half that matters most: Cmd-Z inside a text field belongs to the text
 * field. Hijacking it to resurrect a record deleted a minute ago would be worse
 * than shipping no shortcut at all.
 */
describe('shouldHandleUndoShortcut (#265)', () => {
  /**
   * This suite runs in vitest's `node` environment (see vitest.config.ts — the
   * repo has no jsdom), so instead of real elements it passes the one thing the
   * function actually uses: `closest`. `matches` lists the selectors this node
   * or an ancestor would match, which is exactly what `closest` reports and
   * therefore covers the nested-caret case too.
   */
  function target(matches: string[]): EventTarget {
    return {
      closest: (selector: string) =>
        selector.split(',').some((part) => matches.includes(part.trim())) ? {} : null,
    } as unknown as EventTarget;
  }

  it('yields to inputs, textareas and selects', () => {
    expect(shouldHandleUndoShortcut(target(['input']))).toBe(false);
    expect(shouldHandleUndoShortcut(target(['textarea']))).toBe(false);
    expect(shouldHandleUndoShortcut(target(['select']))).toBe(false);
  });

  it('yields to the rich-text editor, which is contenteditable and not an input', () => {
    expect(shouldHandleUndoShortcut(target(['[contenteditable="true"]']))).toBe(false);
    expect(shouldHandleUndoShortcut(target(['[role="textbox"]']))).toBe(false);
  });

  it('yields when the caret is NESTED inside an editable surface', () => {
    // A <span> deep inside the editor: it matches nothing itself, but `closest`
    // walks up and finds the contenteditable ancestor.
    expect(shouldHandleUndoShortcut(target(['[contenteditable="true"]']))).toBe(false);
  });

  it('handles the shortcut on ordinary surfaces', () => {
    expect(shouldHandleUndoShortcut(target([]))).toBe(true);
    expect(shouldHandleUndoShortcut(target(['div.table-view']))).toBe(true);
  });

  it('defaults to handling when there is no usable target', () => {
    expect(shouldHandleUndoShortcut(null)).toBe(true);
    // A target with no `closest` (e.g. window/document) must not throw.
    expect(shouldHandleUndoShortcut({} as EventTarget)).toBe(true);
  });
});
