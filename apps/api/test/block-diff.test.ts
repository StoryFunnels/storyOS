import { describe, expect, it } from 'vitest';
import { diffBlocks } from '@storyos/schemas/block-diff';

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
