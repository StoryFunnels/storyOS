import { describe, expect, it } from 'vitest';
import { creatableFieldTypeSchema } from '@storyos/schemas';
import {
  NO_TEXT_PLACEHOLDER,
  OBJECT_PLACEHOLDER,
  REMOVED_MEMBER_LABEL,
  blockLines,
  formatActivityValue,
  resolveBlockChanges,
  truncateText,
} from './activity-format';

const names: Record<string, string> = { u1: 'Ievgen Krasovytskyi', u2: 'Dara' };
const name = (id: string) => names[id];

describe('formatActivityValue (#806)', () => {
  it('shows a person field as a NAME, never the id', () => {
    expect(formatActivityValue('u1', 'user', name)).toBe('Ievgen Krasovytskyi');
    expect(formatActivityValue(['u1', 'u2'], 'user', name)).toBe('Ievgen Krasovytskyi, Dara');
  });

  it('resolves the audit person types the same way', () => {
    expect(formatActivityValue('u2', 'created_by', name)).toBe('Dara');
    expect(formatActivityValue('u2', 'updated_by', name)).toBe('Dara');
  });

  it('a member who has since been removed resolves to the shared fallback, not the id', () => {
    const out = formatActivityValue('gone-id', 'user', name);
    expect(out).toBe(REMOVED_MEMBER_LABEL);
    expect(out).not.toContain('gone-id');
  });

  it('empty stays "empty", including inside a list', () => {
    expect(formatActivityValue(null, 'user', name)).toBe('empty');
    expect(formatActivityValue(undefined, undefined, name)).toBe('empty');
  });

  // What the type test must KEEP: a text value that happens to look like a member id is not a member.
  it('leaves every non-person type exactly as the API sent it', () => {
    expect(formatActivityValue('u1', 'text', name)).toBe('u1');
    expect(formatActivityValue('Done', 'select', name)).toBe('Done');
    expect(formatActivityValue(42, 'number', name)).toBe('42');
    expect(formatActivityValue(true, 'checkbox', name)).toBe('true');
    expect(formatActivityValue('u1', undefined, name)).toBe('u1'); // field unknown (e.g. deleted): never guess
  });
});

// ─── #829 ────────────────────────────────────────────────────────────────────

const para = (id: string, text: string, props: Record<string, unknown> = {}) => ({
  id,
  type: 'paragraph',
  props,
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});
const blocks = (n: number, prefix = 'Line') => Array.from({ length: n }, (_, i) => para(`b${i}`, `${prefix} ${i}`));

/**
 * The class, not the instance: the formatter has been fixed three times
 * (#796, #806, #829), each time for the case in front of it. So this crosses EVERY
 * creatable field type — derived from the schema, so a type added tomorrow is covered
 * without anyone remembering — with every object-shaped value a stored field could
 * plausibly hold, and requires that NONE of them stringifies as an object.
 */
describe('no value reaches String() as an object (#829)', () => {
  const objectValues: Array<[string, unknown]> = [
    ['rich_text blocks', blocks(14)],
    ['a single block', para('x', 'one')],
    ['blocks with no text', [{ id: 'i', type: 'image', props: {}, children: [] }]],
    ['attachment files', [{ id: 'f1', name: 'cv.pdf', size: 12 }, { id: 'f2', name: 'photo.png' }]],
    ['an unknown object', { a: 1, b: { c: 2 } }],
    ['an array of unknown objects', [{ a: 1 }, { b: 2 }]],
    ['nested arrays', [[{ a: 1 }], [{ b: 2 }]]],
    ['an empty object', {}],
  ];
  const types = [...creatableFieldTypeSchema.options, 'title', 'relation', 'created_at', 'something_new', undefined];

  for (const type of types) {
    for (const [label, value] of objectValues) {
      it(`${type ?? 'unknown type'} × ${label}`, () => {
        const out = formatActivityValue(value, type, () => undefined);
        expect(out).not.toContain('[object Object]');
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
      });
    }
  }

  it('an unrecognised object renders the placeholder, not its stringified form', () => {
    expect(formatActivityValue({ a: 1 }, 'something_new', () => undefined)).toBe(OBJECT_PLACEHOLDER);
  });
});

describe('rich_text as text (#829)', () => {
  it('reads a block array as its text', () => {
    expect(formatActivityValue(blocks(3), 'rich_text', () => undefined)).toBe('Line 0 / Line 1 / Line 2');
  });
  it('truncates a long document rather than printing all of it', () => {
    const out = formatActivityValue(blocks(40, 'A long responsibility line'), 'rich_text', () => undefined);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith('…')).toBe(true);
  });
  it('says so when the blocks hold no text', () => {
    expect(formatActivityValue([{ id: 'i', type: 'image', props: {}, children: [] }], 'rich_text', () => undefined)).toBe(NO_TEXT_PLACEHOLDER);
  });
  it('an empty document is "empty", like any other empty value', () => {
    expect(formatActivityValue([], 'rich_text', () => undefined)).toBe('empty');
  });
  it('lists attachment file names', () => {
    expect(formatActivityValue([{ id: 'f', name: 'cv.pdf' }, { id: 'g', name: 'b.png' }], 'attachment', () => undefined)).toBe('cv.pdf, b.png');
  });
  it('truncateText flattens whitespace', () => {
    expect(truncateText('a\n  b   c')).toBe('a b c');
  });
});

describe('resolveBlockChanges — legacy rows are recomputed, not given up on (#829)', () => {
  // #840 — this used to assert "uses the stored blocks when the row has them",
  // which quietly specified the defect: rows written before #840 carry blocks the
  // old diff got wrong (every block of API-written content stored as "changed"),
  // and history rows cannot be repaired. The renderer now recomputes from from/to.
  it('does NOT trust stored blocks that disagree with from/to: a stored phantom "changed" is dropped (#840)', () => {
    const from = [para('b0', 'Line 0'), para('b1', 'Line 1')];
    const to = [para('b0', 'Line 0'), para('b1', 'Line 1')]; // identical
    const phantom = [
      { kind: 'changed' as const, blockId: 'b0', from: from[0], to: to[0] },
      { kind: 'changed' as const, blockId: 'b1', from: from[1], to: to[1] },
    ];
    expect(resolveBlockChanges({ from, to, blocks: phantom }, 'rich_text')).toEqual([]);
  });

  it('falls back to the stored blocks only for a value that is not block-shaped at all', () => {
    const stored = [{ kind: 'added' as const, blockId: 'x', to: para('x', 'new') }];
    expect(resolveBlockChanges({ from: 'a', to: 'b', blocks: stored }, 'text')).toBe(stored);
  });

  // The screenshot's rows: `from`/`to` are full block arrays but there is no `blocks`.
  it('recomputes a block diff from raw from/to when a legacy row has no `blocks`', () => {
    const from = blocks(3);
    const to = [para('b0', 'Line 0'), para('b1', 'EDITED'), para('b2', 'Line 2'), para('b3', 'Added')];
    const out = resolveBlockChanges({ from, to }, 'rich_text')!;
    expect(out.map((c) => c.kind).sort()).toEqual(['added', 'changed']);
  });

  it('recognises a block array even when the field type is unknown', () => {
    expect(resolveBlockChanges({ from: blocks(1), to: blocks(2) }, undefined)).toBeDefined();
  });

  it('leaves every non-rich-text change to the scalar formatter', () => {
    expect(resolveBlockChanges({ from: 'a', to: 'b' }, 'text')).toBeUndefined();
    expect(resolveBlockChanges({ from: ['x'], to: ['y'] }, 'multi_select')).toBeUndefined();
  });
});

describe('blockLines (#829)', () => {
  it('turns added / removed / changed blocks into readable lines', () => {
    const lines = blockLines([
      { kind: 'added', blockId: 'a', to: para('a', 'New point') },
      { kind: 'removed', blockId: 'r', from: para('r', 'Gone point') },
      { kind: 'changed', blockId: 'c', from: para('c', 'Before'), to: para('c', 'After') },
    ]);
    expect(lines).toEqual([
      { kind: 'added', text: 'New point' },
      { kind: 'removed', text: 'Gone point' },
      { kind: 'changed', from: 'Before', to: 'After' },
    ]);
  });

  // The first save after content was written by the API or an agent makes the editor add
  // default props to EVERY block: the diff correctly sees fourteen changes, and a person
  // reading "X → X" fourteen times learns nothing.
  it('collapses blocks whose text did not change into ONE formatting line', () => {
    const changes = Array.from({ length: 14 }, (_, i) => ({
      kind: 'changed' as const,
      blockId: `b${i}`,
      from: para(`b${i}`, `Line ${i}`),
      to: para(`b${i}`, `Line ${i}`, { textColor: 'default' }),
    }));
    expect(blockLines(changes)).toEqual([{ kind: 'formatting', count: 14 }]);
  });

  it('keeps a real text change visible next to the formatting count', () => {
    const lines = blockLines([
      { kind: 'changed', blockId: 'a', from: para('a', 'Line'), to: para('a', 'Line', { textColor: 'default' }) },
      { kind: 'changed', blockId: 'b', from: para('b', 'Old'), to: para('b', 'New') },
    ]);
    expect(lines).toEqual([{ kind: 'changed', from: 'Old', to: 'New' }, { kind: 'formatting', count: 1 }]);
  });

  it('an empty diff is an empty list (the caller says so, it does not print a blank)', () => {
    expect(blockLines([])).toEqual([]);
  });
});
