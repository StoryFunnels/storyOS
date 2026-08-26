import { describe, expect, it } from 'vitest';
import { SHORTCUTS, formatShortcut, shortcutKeys, withShortcut } from './shortcuts';

/**
 * #396 — the platform bug, asserted rather than eyeballed.
 *
 * Every hint the product rendered said ⌘, because the registry stored the mac
 * glyph as its display string. On Windows and Linux the modifier is Ctrl, so
 * the product was teaching those users a shortcut that does nothing — worse
 * than saying nothing, because it costs a try and then trust.
 *
 * It survived #254 (which built the registry) for one reason: nobody ever
 * asserted what a non-Mac reader sees. That is the gap these tests close.
 */

describe('formatShortcut', () => {
  it('renders the Mac form with no separator', () => {
    expect(formatShortcut('mod+K', true)).toBe('⌘K');
  });

  it('renders the non-Mac form as Ctrl+', () => {
    // Each platform's own convention, rather than picking one and imposing it.
    expect(formatShortcut('mod+K', false)).toBe('Ctrl+K');
  });

  it('leaves a token with no modifier alone on both platforms', () => {
    for (const isMac of [true, false]) {
      expect(formatShortcut('n', isMac)).toBe('n');
      expect(formatShortcut('Enter', isMac)).toBe('Enter');
      expect(formatShortcut('Esc', isMac)).toBe('Esc');
      expect(formatShortcut('⇧ + click', isMac)).toBe('⇧ + click');
    }
  });
});

describe('the registry itself', () => {
  it('stores NO hardcoded ⌘ — that is the bug, and it must not creep back', () => {
    /*
     * The regression guard that matters. Adding a shortcut by copying a
     * neighbouring line is how the mac glyph would return, and nothing else in
     * the suite would notice.
     */
    const hardcoded = SHORTCUTS.filter((s) => s.keys.includes('⌘'));
    expect(
      hardcoded.map((s) => `${s.id}: ${s.keys}`),
      'Use the platform-neutral "mod+" token; formatShortcut renders it per platform.',
    ).toEqual([]);
  });

  it('every modifier shortcut renders differently on the two platforms', () => {
    const withMod = SHORTCUTS.filter((s) => s.keys.includes('mod'));
    expect(withMod.length).toBeGreaterThan(0);
    for (const s of withMod) {
      expect(formatShortcut(s.keys, true)).not.toBe(formatShortcut(s.keys, false));
    }
  });

  it('has no duplicate ids — they are the lookup key for every hint', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('advertises the cheat-sheet itself', () => {
    // #396's whole complaint: the one shortcut that teaches the others.
    expect(SHORTCUTS.find((s) => s.id === 'help')?.keys).toBe('?');
  });
});

describe('shortcutKeys returns the RAW token, deliberately', () => {
  it('does not format, so a caller cannot render "mod+K" thinking it is display-ready', () => {
    // Kept unformatted rather than quietly formatted: a silently-Mac default is
    // exactly what produced the original bug.
    expect(shortcutKeys('palette')).toBe('mod+K');
  });

  it('is null for an unknown id', () => {
    expect(shortcutKeys('nope')).toBeNull();
  });
});

describe('withShortcut', () => {
  it('appends the platform-correct keys', () => {
    expect(withShortcut('Search', 'palette', true)).toBe('Search (⌘K)');
    expect(withShortcut('Search', 'palette', false)).toBe('Search (Ctrl+K)');
  });

  it('degrades to the bare title on an unknown id rather than rendering "undefined"', () => {
    expect(withShortcut('Search', 'typo')).toBe('Search');
  });
});
