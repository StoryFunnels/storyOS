import { describe, expect, it } from 'vitest';
import { blockPlainText } from './entity-field-utils';

describe('blockPlainText — #677 (Gap 2) human-readable document-diff text', () => {
  it('extracts text from a simple paragraph block', () => {
    const block = {
      id: 'b1',
      type: 'paragraph',
      content: [{ type: 'text', text: 'Hello world' }],
    };
    expect(blockPlainText(block)).toBe('Hello world');
  });

  it('joins text across multiple inline nodes (e.g. bold + plain runs)', () => {
    const block = {
      id: 'b1',
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello', styles: { bold: true } },
        { type: 'text', text: 'world' },
      ],
    };
    expect(blockPlainText(block)).toBe('Hello world');
  });

  it('renders an empty block as "(empty block)", never a blank string a reader could mistake for no change', () => {
    const block = { id: 'b1', type: 'paragraph', content: [] };
    expect(blockPlainText(block)).toBe('(empty block)');
  });

  it('does not crash on null/undefined (a removed or malformed block)', () => {
    expect(blockPlainText(null)).toBe('(empty block)');
    expect(blockPlainText(undefined)).toBe('(empty block)');
  });

  it('walks nested block content (e.g. a list item containing further blocks)', () => {
    const block = {
      id: 'b1',
      type: 'bulletListItem',
      content: [{ type: 'text', text: 'Item one' }],
      children: [
        {
          id: 'b2',
          type: 'paragraph',
          content: [{ type: 'text', text: 'nested' }],
        },
      ],
    };
    expect(blockPlainText(block)).toBe('Item one nested');
  });
});
