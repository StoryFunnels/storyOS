import { describe, expect, it } from 'vitest';
import { canonicalJson, diffBlocks, jsonEqual } from '@storyos/schemas/block-diff';

const p = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  content: [{ type: 'text', text, styles: {} }],
});

describe('diffBlocks (#595)', () => {
  it('reports nothing for identical documents', () => {
    const doc = [p('b1', 'Hello'), p('b2', 'World')];
    expect(diffBlocks(doc, doc.map((b) => ({ ...b })))).toEqual([]);
  });

  it('reports an added block', () => {
    const before = [p('b1', 'Hello')];
    const after = [p('b1', 'Hello'), p('b2', 'World')];
    expect(diffBlocks(before, after)).toEqual([{ kind: 'added', blockId: 'b2', to: p('b2', 'World') }]);
  });

  it('reports a removed block', () => {
    const before = [p('b1', 'Hello'), p('b2', 'World')];
    const after = [p('b1', 'Hello')];
    expect(diffBlocks(before, after)).toEqual([{ kind: 'removed', blockId: 'b2', from: p('b2', 'World') }]);
  });

  it('reports a changed block by id, with its own from/to', () => {
    const before = [p('b1', 'Hello')];
    const after = [p('b1', 'Goodbye')];
    expect(diffBlocks(before, after)).toEqual([
      { kind: 'changed', blockId: 'b1', from: p('b1', 'Hello'), to: p('b1', 'Goodbye') },
    ]);
  });

  /**
   * The exact ambiguity flagged on ticket #595 (Otto: "what counts as a
   * change when a block MOVES versus when its content changes"). Identity
   * by id resolves it: same id + same content, regardless of position, is
   * not a change at all.
   */
  it('does NOT report a change for a block that only moved position', () => {
    const before = [p('b1', 'First'), p('b2', 'Second')];
    const after = [p('b2', 'Second'), p('b1', 'First')];
    expect(diffBlocks(before, after)).toEqual([]);
  });

  it('reports only the block that changed content, even when siblings moved around it', () => {
    const before = [p('b1', 'First'), p('b2', 'Second'), p('b3', 'Third')];
    const after = [p('b3', 'Third'), p('b1', 'First edited'), p('b2', 'Second')];
    expect(diffBlocks(before, after)).toEqual([
      { kind: 'changed', blockId: 'b1', from: p('b1', 'First'), to: p('b1', 'First edited') },
    ]);
  });

  it('handles a block missing an id by positional fallback rather than crashing', () => {
    const before = [{ type: 'paragraph', content: [{ type: 'text', text: 'no id', styles: {} }] }];
    const after = [{ type: 'paragraph', content: [{ type: 'text', text: 'edited', styles: {} }] }];
    const changes = diffBlocks(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('changed');
  });

  // #796 — the positional-fallback identity used to be `\0#${index}`, a
  // literal NUL byte. RecordsService.update() writes a BlockChange straight
  // into activity_events.payload (jsonb), and Postgres's jsonb rejects an
  // embedded \u0000 in a text value outright — a 500 on the very first edit
  // of any rich_text field whose blocks predate having ids. The restore-only
  // caller never hit this because a record needs a prior real edit (which
  // always assigns ids) before a version exists to restore.
  it('never returns a blockId containing a NUL byte, even for id-less blocks', () => {
    const before = [{ type: 'paragraph', content: [{ type: 'text', text: 'no id', styles: {} }] }];
    const after = [{ type: 'paragraph', content: [{ type: 'text', text: 'edited', styles: {} }] }];
    const changes = diffBlocks(before, after);
    expect(changes[0]!.blockId).not.toContain('\0');
  });

  it('returns an empty diff for non-array input rather than throwing', () => {
    expect(diffBlocks(null, undefined)).toEqual([]);
    expect(diffBlocks('not-an-array', 42)).toEqual([]);
  });

  it('combines multiple added, removed and changed blocks in one call', () => {
    const before = [p('b1', 'Keep'), p('b2', 'Remove me'), p('b3', 'Edit me')];
    const after = [p('b1', 'Keep'), p('b3', 'Edited'), p('b4', 'New')];
    const changes = diffBlocks(before, after);
    expect(changes).toHaveLength(3);
    expect(changes).toContainEqual({ kind: 'removed', blockId: 'b2', from: p('b2', 'Remove me') });
    expect(changes).toContainEqual({ kind: 'changed', blockId: 'b3', from: p('b3', 'Edit me'), to: p('b3', 'Edited') });
    expect(changes).toContainEqual({ kind: 'added', blockId: 'b4', to: p('b4', 'New') });
  });
});

/**
 * #840 — "formatting changed in 5 blocks" for a one-line edit.
 *
 * Reproduced against the real API before the fix: a rich_text field written
 * through the API (blocks with no id, the caller's own key order), edited on ONE
 * line, stored all five blocks as `changed`. The cause is not the missing id —
 * id-less blocks were already matched by position and compared — it is that the
 * comparison was JSON.stringify, i.e. KEY ORDER: the stored side comes back from
 * a jsonb column (keys re-sorted shortest-first), the new side arrives in the
 * writer's order, so two identical blocks differed byte-for-byte.
 */
const para = (text: string, order: 'caller' | 'jsonb', id?: string) => {
  const props =
    order === 'caller'
      ? { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' }
      : { textColor: 'default', textAlignment: 'left', backgroundColor: 'default' }; // jsonb's order
  const item = order === 'caller' ? { type: 'text', text, styles: {} } : { text, type: 'text', styles: {} };
  return { ...(id ? { id } : {}), type: 'paragraph', props, content: [item], children: [] };
};

describe('key order is not content (#840)', () => {
  it('canonicalJson sorts object keys at every depth but keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(jsonEqual({ a: undefined, b: 1 }, { b: 1 })).toBe(true);
  });

  it('five id-less API-written blocks, one edited line: ONE change, not five — the reproduced bug', () => {
    const lines = ['Intro', 'Second', 'Third', 'Fourth', 'Fifth'];
    const stored = lines.map((t) => para(t, 'jsonb')); // as read back from jsonb
    const incoming = lines.map((t, i) => para(i === 2 ? 'Third EDITED' : t, 'caller')); // as the API caller wrote it
    const changes = diffBlocks(stored, incoming);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('changed');
  });

  it('identical content in a different key order reports NOTHING', () => {
    expect(diffBlocks([para('Same', 'jsonb')], [para('Same', 'caller')])).toEqual([]);
  });

  it('a real formatting-only change (same text, different styling) is STILL reported', () => {
    const plain = para('Bold me', 'caller');
    const bold = { ...plain, content: [{ type: 'text', text: 'Bold me', styles: { bold: true } }] };
    const changes = diffBlocks([plain], [bold]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('changed');
  });
});

describe('id-less content: the matching rule (#840)', () => {
  const lines = ['Alpha', 'Beta', 'Gamma'];

  it('old blocks WITH ids, new blocks WITHOUT: identical content matches, only the edit is reported', () => {
    // Borderlands Jobs #3's shape: the editor wrote ids, the pipeline rewrote without them.
    const before = lines.map((t, i) => para(t, 'jsonb', `id${i}`));
    const after = lines.map((t, i) => para(i === 1 ? 'Beta EDITED' : t, 'caller'));
    const changes = diffBlocks(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', blockId: 'id1' });
  });

  it('dropping every id from unchanged content reports nothing (a missing id never implies a change)', () => {
    const before = lines.map((t, i) => para(t, 'jsonb', `id${i}`));
    expect(diffBlocks(before, lines.map((t) => para(t, 'caller')))).toEqual([]);
  });

  it('an inserted id-less line shifts nothing after it: only the addition is reported', () => {
    const before = lines.map((t) => para(t, 'jsonb'));
    const after = [para('Alpha', 'caller'), para('New line', 'caller'), para('Beta', 'caller'), para('Gamma', 'caller')];
    const changes = diffBlocks(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'added' });
  });

  it('two DIFFERENT ids are never merged on content: that is a removal and an addition', () => {
    const changes = diffBlocks([para('Same', 'caller', 'a')], [para('Same', 'caller', 'b')]);
    expect(changes.map((c) => c.kind).sort()).toEqual(['added', 'removed']);
  });

  it('never emits a NUL byte or an undefined id for any pairing', () => {
    const changes = diffBlocks([para('x', 'caller'), para('y', 'caller', 'k')], [para('z', 'caller'), para('w', 'caller')]);
    for (const c of changes) {
      expect(typeof c.blockId).toBe('string');
      expect(c.blockId).not.toContain('\0');
    }
  });
});
