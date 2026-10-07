import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas';

/**
 * #822 — the cases beyond Ada's drop-in suite (markdown-nesting.unit.test.ts), chosen
 * because each is a way the serializer and parser could drift apart. AC8 asks that
 * parse(serialize(doc)) preserve STRUCTURE, not just that the text is still somewhere.
 */
const t = (text: string) => [{ type: 'text', text, styles: {} }];
const b = (type: string, extra: Record<string, unknown> = {}) => ({ id: type, type, props: {}, children: [], ...extra });
/* eslint-disable @typescript-eslint/no-explicit-any */
const parse = (md: string) => markdownToBlocks(md) as any[];

describe('AC8 — parse(serialize(doc)) preserves STRUCTURE', () => {
  const doc = [
    b('bulletListItem', { content: t('parent'), children: [
      b('bulletListItem', { content: t('child'), children: [b('bulletListItem', { content: t('grandchild') })] }),
      b('checkListItem', { props: { checked: true }, content: t('done child') }),
    ] }),
    b('image', { props: { url: 'https://example.com/a.png', caption: 'a diagram' } }),
    b('divider'),
    b('toggleListItem', { content: t('toggle title'), children: [b('paragraph', { content: t('inside the toggle') })] }),
  ];
  const back = parse(blocksToMarkdown(doc));

  it('nesting comes back as nesting, at the right depth', () => {
    expect(back[0].type).toBe('bulletListItem');
    expect(back[0].children.map((c: any) => c.type)).toEqual(['bulletListItem', 'checkListItem']);
    expect(back[0].children[0].children[0].content[0].text).toBe('grandchild');
    expect(back[0].children[1].props.checked).toBe(true);
  });
  it('the image comes back as an image block with its URL and caption', () => {
    const img = back.find((x) => x.type === 'image');
    expect(img.props).toMatchObject({ url: 'https://example.com/a.png', caption: 'a diagram' });
  });
  it('the divider comes back as a divider block', () => {
    expect(back.map((x) => x.type)).toContain('divider');
  });
  it("a toggle's BODY comes back nested under its title, not as a sibling", () => {
    const toggle = back.find((x) => x.content?.[0]?.text === 'toggle title');
    expect(toggle.type).toBe('bulletListItem'); // the type is lost; the content is not
    expect(toggle.children[0].content[0].text).toBe('inside the toggle');
  });
  it('is stable: a second pass changes nothing', () => {
    const once = blocksToMarkdown(back);
    expect(blocksToMarkdown(parse(once))).toBe(once);
  });
});

describe('nesting syntax the serializer and agents actually produce', () => {
  it('nests a sub-item under a numbered item at its marker width, including 10.', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      b('numberedListItem', { content: t(`n${i + 1}`), children: i === 9 ? [b('bulletListItem', { content: t('under ten') })] : [] }));
    const md = blocksToMarkdown(items);
    expect(md).toMatch(/^ {4}- under ten$/m); // "10. " is 4 wide
    const back = parse(md);
    expect(back).toHaveLength(10);
    expect(back[9].children[0].content[0].text).toBe('under ten');
  });
  it.each([
    ['2 spaces', '- a\n  - b'],
    ['3 spaces', '- a\n   - b'],
    ['4 spaces', '- a\n    - b'],
    ['a tab', '- a\n\t- b'],
  ])('reads %s of indentation as nesting', (_label, md) => {
    const blocks = parse(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].children[0].content[0].text).toBe('b');
  });
  it('returns to the right level: a sibling after a nested run is not swallowed', () => {
    const blocks = parse('- a\n  - a1\n    - a2\n  - a1b\n- b');
    expect(blocks.map((x) => x.content[0].text)).toEqual(['a', 'b']);
    expect(blocks[0].children.map((x: any) => x.content[0].text)).toEqual(['a1', 'a1b']);
    expect(blocks[1].children).toBeUndefined();
  });
  it('round-trips a code block nested under a list item', () => {
    const doc = [b('bulletListItem', { content: t('run it'), children: [
      b('codeBlock', { props: { language: 'js' }, content: t('const a = 1;\nconst b = 2;') }),
    ] })];
    const md = blocksToMarkdown(doc);
    expect(md).toContain('  ```js');
    const code = parse(md)[0].children[0];
    expect(code.type).toBe('codeBlock');
    expect(code.content[0].text).toBe('const a = 1;\nconst b = 2;');
  });
  it('round-trips a table nested under a list item', () => {
    const table = b('table', { content: { type: 'tableContent', headerRows: 1, rows: [{ cells: [t('h1'), t('h2')] }, { cells: [t('x'), t('y')] }] } });
    const back = parse(blocksToMarkdown([b('bulletListItem', { content: t('data'), children: [table] })]));
    expect(back[0].children[0].type).toBe('table');
    expect(back[0].children[0].content.rows).toHaveLength(2);
  });
});

describe('what must NOT change', () => {
  it('an indented line with no list item above it is still a literal-text paragraph', () => {
    for (const md of ['    just text', ' - x']) {
      const [block] = parse(md);
      expect(block.type).toBe('paragraph');
      expect(block.content[0].text).toBe(md);
    }
  });
  it('a top-level paragraph resets nesting', () => {
    const blocks = parse('- a\n  - b\n\ntext\n\n- c');
    expect(blocks.map((x) => x.type)).toEqual(['bulletListItem', 'paragraph', 'bulletListItem']);
  });
  it('a paragraph with children keeps the CONTENT, flattened (Markdown cannot express the depth)', () => {
    const md = blocksToMarkdown([b('paragraph', { content: t('intro'), children: [b('bulletListItem', { content: t('detail') })] })]);
    expect(md).toContain('intro');
    expect(md).toContain('- detail');
  });
});

describe('media and hostile input', () => {
  it('writes a URL the parser can read back: spaces and parentheses are encoded', () => {
    const md = blocksToMarkdown([b('image', { props: { url: 'https://x.test/a b(1).png', caption: 'pic' } })]);
    expect(md).toBe('![pic](https://x.test/a%20b%281%29.png)');
    expect(parse(md)[0].props.url).toBe('https://x.test/a%20b%281%29.png');
  });
  it('keeps brackets out of the alt text, where they would end the link early', () => {
    const md = blocksToMarkdown([b('image', { props: { url: 'https://x.test/a.png', caption: 'a [b] c' } })]);
    expect(md).toBe('![a b c](https://x.test/a.png)');
  });
  it('falls back to the file name when there is no caption', () => {
    expect(blocksToMarkdown([b('image', { props: { url: 'https://x.test/a.png', name: 'a.png' } })])).toBe('![a.png](https://x.test/a.png)');
  });
  it('does not drop a file/video/audio block either', () => {
    for (const type of ['file', 'video', 'audio']) {
      expect(blocksToMarkdown([b(type, { props: { url: 'https://x.test/f', name: 'the file' } })])).toBe('[the file](https://x.test/f)');
    }
  });
  it('a pathologically deep document is flattened, not dropped and not a stack overflow', () => {
    let node: any = b('bulletListItem', { content: t('deepest') });
    for (let i = 0; i < 300; i++) node = b('bulletListItem', { content: t(`level ${i}`), children: [node] });
    const md = blocksToMarkdown([node]);
    expect(md).toContain('deepest');
    expect(md).toContain('level 299');
  });
});
