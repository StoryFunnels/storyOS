import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './send-email.action';

/**
 * MN-256 — the dependency-free markdown-lite renderer's own snapshot-style
 * coverage. The full send/gate/cap/webhook behavior is covered end to end
 * against a real Postgres in test/send-email-automation.test.ts (mirrors
 * job-runner.service.test.ts + test/automation-jobs.test.ts's own split).
 */
describe('markdownToHtml (MN-256)', () => {
  it('wraps a single paragraph', () => {
    expect(markdownToHtml('Hello there')).toBe('<p style="margin: 0 0 12px;">Hello there</p>');
  });

  it('splits on a blank line into separate paragraphs', () => {
    const html = markdownToHtml('First paragraph.\n\nSecond paragraph.');
    expect(html).toBe(
      '<p style="margin: 0 0 12px;">First paragraph.</p>\n<p style="margin: 0 0 12px;">Second paragraph.</p>',
    );
  });

  it('renders bold, italic, inline code, and a link', () => {
    const html = markdownToHtml('**bold** and *italic* and `code` and [a link](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com">a link</a>');
  });

  it('HTML-escapes the source before applying markdown — a rendered {Field} value cannot inject markup', () => {
    const html = markdownToHtml('Ticket <script>alert(1)</script> is done');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('a single newline within one block becomes <br>, not a new paragraph', () => {
    const html = markdownToHtml('Line one\nLine two');
    expect(html).toBe('<p style="margin: 0 0 12px;">Line one<br>Line two</p>');
  });
});
