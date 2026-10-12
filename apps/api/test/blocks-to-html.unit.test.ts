import { describe, expect, it } from 'vitest';
import { blocksToHtml, escapeHtml } from '../src/documents/export/blocks-to-html';

/**
 * #262 phase 2 — BlockNote blocks → the self-contained HTML the PDF sidecar
 * renders. Pure: no DB, no app, no network.
 *
 * The properties under test are the ones a PDF cannot recover from: nothing a
 * document contains is silently dropped, nothing a document contains can inject
 * markup, and nothing in the output points outside itself (the sidecar has no
 * egress).
 */
const t = (text: string, styles: Record<string, boolean> = {}) => ({ type: 'text', text, styles });
const none = { resolveImage: async () => null };
const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';
const withImage = { resolveImage: async (u: string) => (u === 'known' ? PIXEL : null) };

async function html(blocks: unknown, opts: Parameters<typeof blocksToHtml>[2] = none) {
  return blocksToHtml('Title', blocks, opts);
}

describe('structure is kept', () => {
  it('nests list children as a list inside the parent item, at any depth', async () => {
    const { html: out } = await html([
      { type: 'bulletListItem', content: [t('a')], children: [{ type: 'bulletListItem', content: [t('b')], children: [{ type: 'bulletListItem', content: [t('c')] }] }] },
    ]);
    expect(out).toContain('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>');
  });

  it('groups consecutive items into ONE list, and starts a new list when the family changes', async () => {
    const { html: out } = await html([
      { type: 'bulletListItem', content: [t('x')] },
      { type: 'bulletListItem', content: [t('y')] },
      { type: 'numberedListItem', content: [t('one')] },
      { type: 'numberedListItem', content: [t('two')] },
    ]);
    expect(out).toContain('<ul><li>x</li><li>y</li></ul>');
    expect(out).toContain('<ol><li>one</li><li>two</li></ol>');
  });

  it('keeps a numbered list\'s start, and checklist state', async () => {
    const { html: out } = await html([
      { type: 'numberedListItem', props: { start: 5 }, content: [t('five')] },
      { type: 'checkListItem', props: { checked: true }, content: [t('done')] },
      { type: 'checkListItem', props: { checked: false }, content: [t('todo')] },
    ]);
    expect(out).toContain('<ol start="5">');
    expect(out).toContain('&#9745;');
    expect(out).toContain('&#9744;');
  });

  it('keeps a toggle\'s title AND its body, and a divider', async () => {
    const { html: out } = await html([
      { type: 'toggleListItem', content: [t('title')], children: [{ type: 'paragraph', content: [t('BODY')] }] },
      { type: 'divider' },
    ]);
    expect(out).toContain('title');
    expect(out).toContain('BODY');
    expect(out).toContain('<hr>');
  });

  it('children of a non-list block are kept, indented', async () => {
    const { html: out } = await html([{ type: 'paragraph', content: [t('parent')], children: [{ type: 'paragraph', content: [t('kid')] }] }]);
    expect(out).toContain('<div class="children"><p>kid</p></div>');
  });

  it('renders a table with the header rows in <thead>, for both cell shapes BlockNote has shipped', async () => {
    const { html: out } = await html([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          headerRows: 1,
          rows: [{ cells: [[t('H')], { type: 'tableCell', content: [t('H2')] }] }, { cells: [[t('a')], { type: 'tableCell', content: [t('b')] }] }],
        },
      },
    ]);
    expect(out).toContain('<thead><tr><th>H</th><th>H2</th></tr></thead>');
    expect(out).toContain('<td>a</td><td>b</td>');
  });

  it('renders code verbatim, in <pre>', async () => {
    const { html: out } = await html([{ type: 'codeBlock', content: [t('if (a < b) {\n  go();\n}')] }]);
    expect(out).toContain('<pre><code>if (a &lt; b) {\n  go();\n}</code></pre>');
  });

  it('applies inline styles, links and mentions', async () => {
    const { html: out } = await html([
      {
        type: 'paragraph',
        content: [
          t('b', { bold: true }),
          t('i', { italic: true }),
          t('c', { code: true }),
          { type: 'link', href: 'https://example.com/x?y=1&z=2', content: [t('link')] },
          { type: 'mention', props: { kind: 'user', id: 'u1', label: 'Ada' } },
          { type: 'mention', props: { kind: 'record', id: 'r1', label: 'Fix it' } },
        ],
      },
    ]);
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>i</em>');
    expect(out).toContain('<code>c</code>');
    expect(out).toContain('<a href="https://example.com/x?y=1&amp;z=2">link</a>');
    expect(out).toContain('@Ada');
    expect(out).toContain('#Fix it');
  });

  it('an unknown block type still renders its text rather than vanishing', async () => {
    const { html: out } = await html([{ type: 'someFutureBlock', content: [t('still here')] }]);
    expect(out).toContain('still here');
  });
});

describe('images', () => {
  it('inlines a resolvable image with its caption', async () => {
    const r = await html([{ type: 'image', props: { url: 'known', caption: 'cap' } }], withImage);
    expect(r.html).toContain(`<img src="${PIXEL}" alt="cap">`);
    expect(r.html).toContain('<figcaption>cap</figcaption>');
    expect(r.skippedImages).toBe(0);
  });

  it('an unresolvable image is a VISIBLE placeholder and is counted — never silently dropped', async () => {
    const r = await html([
      { type: 'image', props: { url: 'https://elsewhere.example/a.png', caption: 'gone' } },
      { type: 'image', props: { url: 'also-unknown' } },
    ]);
    expect(r.html).toContain('[Image not included: gone]');
    expect(r.html).toContain('[Image not included]');
    expect(r.skippedImages).toBe(2);
  });

  it('an image block with no url at all is empty, not a failure to report', async () => {
    const r = await html([{ type: 'image', props: { url: '' } }]);
    expect(r.skippedImages).toBe(0);
    expect(r.html).not.toContain('Image not included');
  });
});

describe('safety', () => {
  it('escapes every piece of document text, including the title', async () => {
    const r = await blocksToHtml('<b>"T"</b>', [{ type: 'paragraph', content: [t('<script>alert(1)</script> & "q"')] }], none);
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<b>"T"</b>');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
  });

  it('drops a javascript:/data: link target and keeps the visible text', async () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'not a url', '//evil.example/x']) {
      const r = await html([{ type: 'paragraph', content: [{ type: 'link', href, content: [t('visible')] }] }]);
      expect(r.html, href).toContain('visible');
      expect(r.html, href).not.toContain(`href="${href}"`);
      expect(r.html, href).not.toMatch(/<a href="(javascript|data):/);
    }
  });

  it('references nothing outside itself — no stylesheet, script, or remote resource', async () => {
    const r = await html([
      { type: 'paragraph', content: [t('hi')] },
      { type: 'image', props: { url: 'known' } },
    ], withImage);
    expect(r.html).not.toMatch(/<link\b|<script\b|@import|url\(\s*["']?https?:/i);
    expect(r.html).not.toMatch(/\b(src|href)="https?:/i);
  });

  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('layout promises that stop "text cut through at the margins"', () => {
  it('breaks long unbroken strings and wraps code instead of letting it run past the page', async () => {
    const r = await html([{ type: 'paragraph', content: [t('x')] }]);
    expect(r.html).toMatch(/overflow-wrap:\s*anywhere/);
    expect(r.html).toMatch(/pre\s*{[^}]*white-space:\s*pre-wrap/);
    expect(r.html).toMatch(/table-layout:\s*fixed/);
    expect(r.html).toMatch(/@page\s*{[^}]*margin:/);
  });
});
