import { describe, expect, it } from 'vitest';
import { parsePatch, toSplitRows } from './diff-parse';

/**
 * #43: GitHub's own unified `patch` text parsed into unified/split diff rows.
 * No diff algorithm here — see the file header — just reading GitHub's hunks
 * back into structured rows, so these tests are really about not losing/
 * misnumbering lines while doing that.
 */
describe('parsePatch', () => {
  it('numbers context/add/del lines from the hunk header', () => {
    const patch = ['@@ -1,3 +1,4 @@', ' keep', '-old line', '+new line', '+another new line', ' tail'].join('\n');
    const rows = parsePatch(patch);
    expect(rows).toEqual([
      { kind: 'hunk', content: '@@ -1,3 +1,4 @@' },
      { kind: 'context', oldLine: 1, newLine: 1, content: 'keep' },
      { kind: 'del', oldLine: 2, content: 'old line' },
      { kind: 'add', newLine: 2, content: 'new line' },
      { kind: 'add', newLine: 3, content: 'another new line' },
      { kind: 'context', oldLine: 3, newLine: 4, content: 'tail' },
    ]);
  });

  it('handles multiple hunks, each restarting line numbers from its own header', () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '@@ -50,1 +50,1 @@',
      '-x',
      '+y',
    ].join('\n');
    const rows = parsePatch(patch);
    expect(rows.filter((r) => r.kind === 'del').map((r) => r.oldLine)).toEqual([1, 50]);
    expect(rows.filter((r) => r.kind === 'add').map((r) => r.newLine)).toEqual([1, 50]);
  });

  it('surfaces a "no newline at end of file" marker without treating it as a content line', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n');
    const rows = parsePatch(patch);
    expect(rows.at(-1)).toEqual({ kind: 'no-newline', content: 'No newline at end of file' });
  });
});

describe('toSplitRows', () => {
  it('pairs a context line with itself on both sides', () => {
    const rows = parsePatch(['@@ -1,1 +1,1 @@', ' same'].join('\n'));
    const split = toSplitRows(rows);
    expect(split[1]).toEqual({
      left: { line: 1, content: 'same', kind: 'context' },
      right: { line: 1, content: 'same', kind: 'context' },
    });
  });

  it('zips a run of deletions against the following run of additions', () => {
    const patch = ['@@ -1,2 +1,3 @@', '-one', '-two', '+ONE', '+TWO', '+THREE'].join('\n');
    const split = toSplitRows(parsePatch(patch));
    // [0] is the hunk marker row.
    expect(split[1]!.left).toMatchObject({ content: 'one', kind: 'del' });
    expect(split[1]!.right).toMatchObject({ content: 'ONE', kind: 'add' });
    expect(split[2]!.left).toMatchObject({ content: 'two', kind: 'del' });
    expect(split[2]!.right).toMatchObject({ content: 'TWO', kind: 'add' });
    // The third addition has no matching deletion — left pads empty.
    expect(split[3]!.left).toEqual({ kind: 'empty', content: '' });
    expect(split[3]!.right).toMatchObject({ content: 'THREE', kind: 'add' });
  });

  it('a pure addition (no preceding deletion) pads the left side', () => {
    const patch = ['@@ -1,0 +1,1 @@', '+brand new line'].join('\n');
    const split = toSplitRows(parsePatch(patch));
    expect(split[1]!.left).toEqual({ kind: 'empty', content: '' });
    expect(split[1]!.right).toMatchObject({ content: 'brand new line', kind: 'add' });
  });

  it('carries the hunk header through as a full-width marker row', () => {
    const split = toSplitRows(parsePatch(['@@ -5,1 +5,1 @@', ' x'].join('\n')));
    expect(split[0]).toEqual({ left: null, right: null, marker: '@@ -5,1 +5,1 @@' });
  });
});
