import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from './long-text-block';

const render = (source: string) => renderToStaticMarkup(createElement(MarkdownBody, { source }));

/**
 * #954 — a `text` field is rendered as Markdown at rest. Its content is untrusted (Linear text, any
 * import), so the tests below are mostly REJECTIONS: what must not reach the page.
 */
describe('MarkdownBody (#954)', () => {
  it('renders links, bold, code, lists and quotes', () => {
    const html = render('See [SF-1046](https://linear.app/x) **bold** `code`\n\n- one\n- two\n\n> quoted');
    expect(html).toContain('<a ');
    expect(html).toContain('href="https://linear.app/x"');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote');
  });

  it('opens every link in a new tab with noopener noreferrer', () => {
    const html = render('[a](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('never renders raw HTML: it comes out as inert text', () => {
    const html = render('hello <b>raw</b> <img src=x onerror="window.__y=1"> <script>window.__x=1</script>');
    expect(html).not.toMatch(/<(b|img|script)[\s>]/);
    expect(html).not.toContain('onerror="');
  });

  it('drops a javascript: link target', () => {
    const html = render('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('does not render images (a remote URL in a synced field would be fetched on view)', () => {
    expect(render('![pic](https://example.com/p.png)')).not.toContain('<img');
  });

  it('keeps plain text whole when it contains no Markdown', () => {
    expect(render('just words')).toContain('just words');
  });
});
