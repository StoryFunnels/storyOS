import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas';

/**
 * #308 — Markdown tables ↔ BlockNote `table` blocks.
 *
 * Before this, `markdownToBlocks` had no table branch at all, so every row fell
 * through to the paragraph default: a table written through the API or MCP became a
 * stack of paragraphs full of pipe characters. `blocksToMarkdown` had no `case
 * 'table'` either, so a table made in the editor was destroyed on the way OUT too.
 *
 * These are pure unit tests — both functions are plain exports, no DB or app needed.
 */

const TABLE = ['| Field | Was | Now |', '| --- | --- | --- |', '| select | dropdown | chips |'].join(
  '\n',
);

type TableBlock = {
  type: string;
  content: { type: string; headerRows?: number; rows: Array<{ cells: Array<Array<{ text?: string }>> }> };
};

const cellText = (b: TableBlock, row: number, col: number) =>
  (b.content.rows[row]?.cells[col] ?? []).map((n) => n.text ?? '').join('');

describe('markdownToBlocks — GFM tables', () => {
  it('produces ONE table block, not a paragraph per row', () => {
    const blocks = markdownToBlocks(TABLE);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('table');
  });

  it('builds BlockNote tableContent with the header marked', () => {
    const b = markdownToBlocks(TABLE)[0] as unknown as TableBlock;
    expect(b.content.type).toBe('tableContent');
    expect(b.content.headerRows).toBe(1);
    expect(b.content.rows).toHaveLength(2);
    expect(cellText(b, 0, 0)).toBe('Field');
    expect(cellText(b, 1, 2)).toBe('chips');
  });

  it('keeps inline formatting and links inside cells', () => {
    const md = ['| a | b |', '| --- | --- |', '| **bold** | [docs](https://example.com) |'].join('\n');
    const b = markdownToBlocks(md)[0] as unknown as TableBlock;
    const boldCell = b.content.rows[1]!.cells[0] as Array<{ text?: string; styles?: Record<string, unknown> }>;
    expect(boldCell.find((n) => n.text === 'bold')?.styles).toEqual({ bold: true });
    const linkCell = b.content.rows[1]!.cells[1] as unknown as Array<{ type: string; href?: string }>;
    expect(linkCell.find((n) => n.type === 'link')?.href).toBe('https://example.com');
  });

  it('accepts alignment markers in the separator', () => {
    const md = ['| a | b | c |', '| :--- | :---: | ---: |', '| 1 | 2 | 3 |'].join('\n');
    expect(markdownToBlocks(md)[0]!.type).toBe('table');
  });

  it('pads a ragged row to the header width instead of throwing', () => {
    const md = ['| a | b | c |', '| --- | --- | --- |', '| 1 |'].join('\n');
    const b = markdownToBlocks(md)[0] as unknown as TableBlock;
    expect(b.content.rows[1]!.cells).toHaveLength(3);
    expect(cellText(b, 1, 0)).toBe('1');
    expect(cellText(b, 1, 2)).toBe('');
  });

  it('treats an escaped pipe as DATA, not a column break', () => {
    const md = ['| a | b |', '| --- | --- |', '| x \\| y | z |'].join('\n');
    const b = markdownToBlocks(md)[0] as unknown as TableBlock;
    expect(b.content.rows[1]!.cells).toHaveLength(2);
    expect(cellText(b, 1, 0)).toBe('x | y');
  });

  /**
   * The regression guard. A pipe is an ordinary character; only a pipe row FOLLOWED
   * by a separator row is a table. Without this, prose and shell commands would be
   * silently swallowed into tables.
   */
  it('leaves a pipe-containing line that is NOT a table as a paragraph', () => {
    expect(markdownToBlocks('Use `grep x | head` to check.')[0]!.type).toBe('paragraph');
    expect(markdownToBlocks('a | b')[0]!.type).toBe('paragraph');
    expect(markdownToBlocks('| a | b |')[0]!.type).toBe('paragraph');
  });

  it('still parses the blocks around a table', () => {
    const blocks = markdownToBlocks(`## Head\n\n${TABLE}\n\nAfter.`);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'table', 'paragraph']);
  });
});

describe('blocksToMarkdown — tables', () => {
  it('renders a table block back to GFM with a separator row', () => {
    const md = blocksToMarkdown(markdownToBlocks(TABLE));
    const lines = md.split('\n');
    expect(lines[0]).toBe('| Field | Was | Now |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines[2]).toBe('| select | dropdown | chips |');
  });

  /**
   * The load-bearing property: markdown → blocks → markdown must be stable, or an
   * agent reading a record and writing it back would corrupt every table it touched.
   */
  it('round-trips: markdown → blocks → markdown is stable', () => {
    const once = blocksToMarkdown(markdownToBlocks(TABLE));
    const twice = blocksToMarkdown(markdownToBlocks(once));
    expect(once).toBe(TABLE);
    expect(twice).toBe(once);
  });

  it('round-trips a table with inline content and an escaped pipe', () => {
    const md = ['| a | b |', '| --- | --- |', '| **x** \\| y | [d](https://e.com) |'].join('\n');
    expect(blocksToMarkdown(markdownToBlocks(md))).toBe(md);
  });

  it('round-trips a document with a table among other blocks', () => {
    const doc = `## Head\n\n${TABLE}\n\nAfter.`;
    expect(blocksToMarkdown(markdownToBlocks(doc))).toBe(doc);
  });

  it('does not emit anything for a table block with no rows', () => {
    expect(
      blocksToMarkdown([{ type: 'table', content: { type: 'tableContent', rows: [] } }]),
    ).toBe('');
  });
});
