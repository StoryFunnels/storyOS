import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas';

// Ada's drop-in suite for #822 (ticket comment, 2026-10-03), verbatim apart from this header.
const t = (text: string) => [{ type: 'text', text, styles: {} }];
const b = (type: string, extra: Record<string, unknown> = {}) => ({ id: type, type, props: {}, children: [], ...extra });

const DOC = [
  b('heading', { props: { level: 2 }, content: t('Plan') }),
  b('bulletListItem', { content: t('parent'), children: [
    b('bulletListItem', { content: t('child'), children: [b('bulletListItem', { content: t('grandchild') })] }),
  ] }),
  b('image', { props: { url: 'https://example.com/a.png', caption: 'a diagram' } }),
  b('divider'),
  b('toggleListItem', { content: t('toggle title'), children: [b('paragraph', { content: t('inside the toggle') })] }),
];

describe('blocksToMarkdown — nothing is silently dropped (#822)', () => {
  const md = blocksToMarkdown(DOC);
  it('keeps nested bullets at two levels', () => {
    for (const s of ['parent', 'child', 'grandchild']) expect(md).toContain(s);
    expect(md).toMatch(/^ {2}- child$/m);
    expect(md).toMatch(/^ {4}- grandchild$/m);
  });
  it('keeps the image', () => expect(md).toContain('![a diagram](https://example.com/a.png)'));
  it('keeps the divider', () => expect(md).toMatch(/^---$/m));
  it('keeps the toggle title AND its body', () => {
    expect(md).toContain('toggle title');
    expect(md).toContain('inside the toggle');
  });
  it('never emits an empty image', () => {
    expect(blocksToMarkdown([b('image', { props: { url: '' } })])).not.toContain('![]');
  });
});

describe('markdownToBlocks — reads what the serializer now writes (AC7)', () => {
  it('rebuilds nesting as children, not literal-text paragraphs', () => {
    const blocks = markdownToBlocks('- parent\n  - child\n    - grandchild') as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].children[0].children[0].content[0].text).toBe('grandchild');
    expect(JSON.stringify(blocks)).not.toContain('- child'); // the corruption this fix must not introduce
  });
  it('parses a lone image line to an image block', () => {
    const [img] = markdownToBlocks('![a diagram](https://example.com/a.png)') as any[];
    expect(img.type).toBe('image');
    expect(img.props.url).toBe('https://example.com/a.png');
  });
  it('parses --- to a divider instead of skipping it', () => {
    expect(markdownToBlocks('a\n\n---\n\nb').map((x) => x.type)).toEqual(['paragraph', 'divider', 'paragraph']);
  });
  it('round-trips presence: blocks → md → blocks → md keeps every text', () => {
    const twice = blocksToMarkdown(markdownToBlocks(blocksToMarkdown(DOC)));
    for (const s of ['parent', 'child', 'grandchild', 'a diagram', 'toggle title', 'inside the toggle']) expect(twice).toContain(s);
  });
});

describe('MUST KEEP WORKING — flat documents unchanged (AC4)', () => {
  it('a flat doc serialises exactly as before', () => {
    const flat = [b('heading', { props: { level: 1 }, content: t('T') }), b('paragraph', { content: t('p') }),
      b('bulletListItem', { content: t('x') }), b('bulletListItem', { content: t('y') })];
    expect(blocksToMarkdown(flat)).toBe('# T\n\np\n\n- x\n- y');
  });
});
