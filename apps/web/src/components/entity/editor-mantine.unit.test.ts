import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditorMantine } from './editor-mantine';
import { StyleNonceProvider } from '@/lib/style-nonce';

/** Ticket #1340: Mantine's own <style> must carry the request nonce, or `style-src-elem` blocks it. */
const probe = createElement('p', null, 'x');
const styleTags = (html: string) => html.match(/<style\b[^>]*>/g) ?? [];

describe('EditorMantine (ticket #1340)', () => {
  it('stamps the request nonce, read from the shared context, on every style element Mantine renders', () => {
    const html = renderToStaticMarkup(
      createElement(StyleNonceProvider, { nonce: 'req-nonce-1', children: createElement(EditorMantine, { children: probe }) }),
    );
    const tags = styleTags(html);
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toContain('nonce="req-nonce-1"');
  });

  it('uses an explicit nonce over the context one', () => {
    const html = renderToStaticMarkup(createElement(EditorMantine, { nonce: 'explicit', children: probe }));
    for (const t of styleTags(html)) expect(t).toContain('nonce="explicit"');
  });

  it('adds no nonce attribute when there is none (no request)', () => {
    const html = renderToStaticMarkup(createElement(EditorMantine, { children: probe }));
    for (const t of styleTags(html)) expect(t).not.toContain('nonce');
  });

  it('keeps the BlockNote fallback shape: no Mantine CSS variables or global color-scheme style at the editor', () => {
    const html = renderToStaticMarkup(createElement(EditorMantine, { nonce: 'n', children: probe }));
    expect(html).not.toContain('--mantine-');
  });
});
