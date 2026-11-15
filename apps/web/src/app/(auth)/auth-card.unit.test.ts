import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthCard, AuthMethods } from './auth-card';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const src = fileURLToPath(new URL('../..', import.meta.url));
const code = (p: string) =>
  readFileSync(join(src, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the auth card: Google first, then "or", then the form (#1302, Otto)', () => {
  const form = createElement('form', { 'data-testid': 'email-form' }, 'email form');
  it('Google configured: button, divider, form, in that order', () => {
    const html = renderToStaticMarkup(
      createElement(AuthMethods, { onGoogle: () => undefined, children: form }),
    );
    const at = (id: string) => html.indexOf(id);
    expect(at('auth-google')).toBeGreaterThan(-1);
    expect(at('auth-google')).toBeLessThan(at('auth-or'));
    expect(at('auth-or')).toBeLessThan(at('email-form'));
    expect(text(html)).toMatch(/Continue with Google\s+or\s+email form/);
    expect(html).toMatch(
      /<button[^>]*class="[^"]*\bh-11\b[^"]*"[^>]*data-testid="auth-google"|<button[^>]*data-testid="auth-google"[^>]*class="[^"]*\bh-11\b/,
    );
  });
  it('Google not configured: the form alone, no divider, no dangling "or"', () => {
    const html = renderToStaticMarkup(
      createElement(AuthMethods, { onGoogle: null, children: form }),
    );
    expect(html).not.toContain('auth-google');
    expect(html).not.toContain('auth-or');
    expect(text(html).trim()).toBe('email form');
  });
  it('the card draws the themed mark, not the fixed-fill image', () => {
    const html = renderToStaticMarkup(createElement(AuthCard, { title: 'T', children: null }));
    expect(html).toContain('data-brand-mark');
    expect(html).not.toContain('/brand/mark.svg');
  });
  it('sign in and sign up both draw their form inside AuthMethods, Google is not drawn after the form, and their submit is 44px', () => {
    for (const p of ['app/(auth)/login/page.tsx', 'app/(auth)/signup/page.tsx']) {
      const page = code(p);
      expect(page, p).toMatch(/<AuthMethods onGoogle=\{[^}]*google[^}]*\}/);
      expect(page.indexOf('<AuthMethods'), p).toBeLessThan(page.indexOf('<form'));
      expect(page, p).not.toMatch(/Continue with Google/);
      expect(page, p).toMatch(/type="submit"\s+size="auth"/);
    }
  });
  it('the reset pages are on the auth card too, so their submit is 44px', () => {
    for (const p of ['app/(auth)/reset/page.tsx', 'app/(auth)/reset/confirm/page.tsx'])
      expect(code(p), p).toMatch(/type="submit" size="auth"/);
  });
});
