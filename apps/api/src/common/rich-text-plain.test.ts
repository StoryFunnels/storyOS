import { describe, expect, it } from 'vitest';
import { isRichTextBlocks, richTextBlocksToPlain } from './rich-text-plain';

const p = (...texts: string[]) => ({ type: 'paragraph', content: texts.map((text) => ({ type: 'text', text, styles: {} })) });

describe('rich text in a template (ticket #456)', () => {
  it('joins inline pieces without a space, blocks with a newline, and follows children', () => {
    const doc = [
      p('We ', 'shipped', ' it'),
      { ...p('Second line'), children: [p('nested')] },
      { type: 'paragraph', content: [{ type: 'link', href: 'https://example.test', content: [{ type: 'text', text: 'a link', styles: {} }] }] },
    ];
    expect(richTextBlocksToPlain(doc)).toBe('We shipped it\nSecond line\nnested\na link');
  });

  it('recognises blocks and nothing else: a list of titled records or of strings is not rich text', () => {
    expect(isRichTextBlocks([p('x')])).toBe(true);
    expect(isRichTextBlocks([])).toBe(false);
    expect(isRichTextBlocks(['a', 'b'])).toBe(false);
    expect(isRichTextBlocks([{ id: '1', title: 'A record' }])).toBe(false);
    expect(isRichTextBlocks('plain')).toBe(false);
  });

  it('an empty document is empty text, not a placeholder', () => {
    expect(richTextBlocksToPlain([{ type: 'paragraph', content: [] }])).toBe('');
  });
});
