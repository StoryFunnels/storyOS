import { describe, expect, it } from 'vitest';
import { markdownToBlocks } from '../src/integrations/markdown-to-blocks';

describe('markdownToBlocks (MN-070)', () => {
  it('converts headings, paragraphs, and inline styles', () => {
    const blocks = markdownToBlocks('# Title\n\nSome **bold** and *italic* and `code`.');
    expect(blocks[0]).toMatchObject({ type: 'heading', props: { level: 1 } });
    expect(blocks[0]!.content).toEqual([{ type: 'text', text: 'Title', styles: {} }]);
    const para = blocks[1]!.content as Array<{ text: string; styles: Record<string, unknown> }>;
    expect(para.find((r) => r.text === 'bold')?.styles).toEqual({ bold: true });
    expect(para.find((r) => r.text === 'italic')?.styles).toEqual({ italic: true });
    expect(para.find((r) => r.text === 'code')?.styles).toEqual({ code: true });
  });

  it('converts links', () => {
    const blocks = markdownToBlocks('See [the docs](https://example.com/x) now.');
    const runs = blocks[0]!.content as Array<{ type: string; href?: string; content?: unknown }>;
    const link = runs.find((r) => r.type === 'link');
    expect(link?.href).toBe('https://example.com/x');
    expect(link?.content).toEqual([{ type: 'text', text: 'the docs', styles: {} }]);
  });

  it('converts bullet, numbered and checkbox lists', () => {
    const blocks = markdownToBlocks('- one\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo');
    expect(blocks.filter((b) => b.type === 'bulletListItem')).toHaveLength(2);
    expect(blocks.filter((b) => b.type === 'numberedListItem')).toHaveLength(2);
    const checks = blocks.filter((b) => b.type === 'checkListItem');
    expect(checks[0]!.props).toEqual({ checked: true });
    expect(checks[1]!.props).toEqual({ checked: false });
  });

  it('converts fenced code blocks preserving content', () => {
    const blocks = markdownToBlocks('```ts\nconst x = 1;\nconst y = 2;\n```');
    expect(blocks[0]).toMatchObject({ type: 'codeBlock', props: { language: 'ts' } });
    expect(blocks[0]!.content).toBe('const x = 1;\nconst y = 2;');
  });

  it('joins wrapped paragraph lines and separates on blank lines', () => {
    const blocks = markdownToBlocks('line one\nline two\n\nsecond para');
    expect(blocks).toHaveLength(2);
    expect((blocks[0]!.content as Array<{ text: string }>)[0]!.text).toBe('line one line two');
  });

  it('never throws on odd input; degrades to text', () => {
    expect(() => markdownToBlocks('**unclosed and [half](')).not.toThrow();
    expect(markdownToBlocks('')).toEqual([]);
  });
});
