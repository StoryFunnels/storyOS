import { describe, expect, it } from 'vitest';
import { OPEN_LAYER_SELECTOR, escapeAction, hasOpenLayer, isTypingTarget, shouldCloseOnEscape } from './escape-layers';

const base = {
  key: 'Escape',
  defaultPrevented: false,
  typing: false,
  inEditor: false,
  layerOpen: false,
  modifier: false,
  composing: false,
  repeat: false,
};

describe('shouldCloseOnEscape (#834)', () => {
  it('closes the record when nothing nearer claims the key', () => {
    expect(shouldCloseOnEscape(base)).toBe(true);
  });

  // Each of these is a layer ABOVE the record: the first Esc belongs to it, not to the record.
  it.each([
    ['typing in an input / editor', { typing: true }],
    ['a menu, popover, picker or dialog was open', { layerOpen: true }],
    ['a handler claimed the event (Radix, the grid selection, the palette)', { defaultPrevented: true }],
  ])('does not close when %s', (_label, override) => {
    expect(shouldCloseOnEscape({ ...base, ...override })).toBe(false);
  });

  it('ignores every other key, modified Escape, IME composition and key-repeat', () => {
    expect(shouldCloseOnEscape({ ...base, key: 'Enter' })).toBe(false);
    expect(shouldCloseOnEscape({ ...base, modifier: true })).toBe(false);
    expect(shouldCloseOnEscape({ ...base, composing: true })).toBe(false);
    // Holding Esc must not close the record and then the next one the page lands on.
    expect(shouldCloseOnEscape({ ...base, repeat: true })).toBe(false);
  });
});

describe('escapeAction in a rich-text editor (#834)', () => {
  // Typing is the one layer that holds unsaved work, so Esc lets go of the editor FIRST
  // and only the next Esc closes the record.
  it('blurs the editor instead of closing the record', () => {
    expect(escapeAction({ ...base, typing: true, inEditor: true })).toBe('blur');
  });
  it('leaves an open @/# picker, menu or dialog to close itself', () => {
    expect(escapeAction({ ...base, typing: true, inEditor: true, layerOpen: true })).toBe('none');
    expect(escapeAction({ ...base, typing: true, inEditor: true, defaultPrevented: true })).toBe('none');
  });
  it('a plain input is left alone: it ends its own edit', () => {
    expect(escapeAction({ ...base, typing: true, inEditor: false })).toBe('none');
  });
});

describe('isTypingTarget', () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as EventTarget;
  it('is true for text controls and contenteditable (the rich-text editor)', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTypingTarget(el(t))).toBe(true);
    expect(isTypingTarget(el('DIV', true))).toBe(true);
  });
  it('is false for the page itself and ordinary elements', () => {
    expect(isTypingTarget(el('BODY'))).toBe(false);
    expect(isTypingTarget(el('DIV'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('hasOpenLayer', () => {
  const doc = (matches: boolean) => ({ querySelector: () => (matches ? ({} as Element) : null) });
  it('reflects whether any overlay is in the DOM', () => {
    expect(hasOpenLayer(doc(true))).toBe(true);
    expect(hasOpenLayer(doc(false))).toBe(false);
  });
  // The trap: aria-expanded is permanently true on collapsible sections and expanded sidebar
  // spaces, so keying on it would make Esc dead everywhere.
  it('does not treat aria-expanded as an open layer', () => {
    expect(OPEN_LAYER_SELECTOR).not.toContain('aria-expanded');
  });
  it('covers dialogs/palette, Radix popper content, menus and listboxes', () => {
    for (const part of ['[role="dialog"]', 'aria-modal', 'data-radix-popper-content-wrapper', '[role="menu"]', '[role="listbox"]']) {
      expect(OPEN_LAYER_SELECTOR).toContain(part);
    }
  });
});
