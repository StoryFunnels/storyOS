import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas';

/**
 * MN-205: mentions must survive a Markdown round-trip so an agent (over MCP) can
 * read AND write them. @member → [@Name](user:<id>), #record → [#Title](record:<id>).
 */
describe('mention markdown round-trip (MN-205)', () => {
  it('serializes a user mention as a user: link', () => {
    const md = blocksToMarkdown([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'ping ', styles: {} },
          { type: 'mention', props: { kind: 'user', id: 'u_1', label: 'Ievgen K.' } },
        ],
      },
    ]);
    expect(md).toBe('ping [@Ievgen K.](user:u_1)');
  });

  it('serializes a record mention as a record: link', () => {
    const md = blocksToMarkdown([
      {
        type: 'paragraph',
        content: [{ type: 'mention', props: { kind: 'record', id: 'r_9', label: 'Acme Project' } }],
      },
    ]);
    expect(md).toBe('[#Acme Project](record:r_9)');
  });

  it('parses a user: link back into a mention node, stripping the @', () => {
    const [block] = markdownToBlocks('hi [@Bob](user:u_42)');
    expect(block!.content).toEqual([
      { type: 'text', text: 'hi ', styles: {} },
      { type: 'mention', props: { kind: 'user', id: 'u_42', label: 'Bob' } },
    ]);
  });

  it('parses a record: link back into a record mention, stripping the #', () => {
    const [block] = markdownToBlocks('[#Roadmap](record:r_7)');
    expect(block!.content).toEqual([
      { type: 'mention', props: { kind: 'record', id: 'r_7', label: 'Roadmap' } },
    ]);
  });

  it('leaves an ordinary link untouched', () => {
    const [block] = markdownToBlocks('see [docs](https://x.com/y)');
    const content = block!.content as Array<{ type: string; href?: string }>;
    expect(content.find((n) => n.type === 'link')?.href).toBe('https://x.com/y');
  });

  it('round-trips a mix of mentions, links and styles unchanged', () => {
    const md = 'Owner [@Ana](user:u_1) on [#Q3 Plan](record:r_2) — see [site](https://a.b) and **bold**';
    expect(blocksToMarkdown(markdownToBlocks(md))).toBe(md);
  });
});
