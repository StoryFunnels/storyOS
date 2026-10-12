import { describe, expect, it } from 'vitest';
import { EMBED_MODES, EMBED_MODE_LABELS, embedModeFromSearch, embedSnippet, parseEmbedMode } from './embed-mode';
import { THEME_INIT_SCRIPT } from './theme';

describe('parseEmbedMode (#721)', () => {
  it('accepts exactly the two values', () => {
    expect(parseEmbedMode('light')).toBe('light');
    expect(parseEmbedMode('dark')).toBe('dark');
  });
  it('treats absent and unrecognised values as light — a typo can never half-paint a page', () => {
    // `auto` is deliberately among them: following the visitor's device was dropped
    // (AC1 — the host decides, never the visitor), so it must NOT silently work.
    for (const bad of [undefined, null, '', 'auto', 'Dark', 'DARK', 'darkest', 'system', 'true', 1, {}, ['dark']]) {
      expect(parseEmbedMode(bad)).toBe('light');
    }
  });
  it('reads the param from a query string', () => {
    expect(embedModeFromSearch('?embed=1&theme=dark')).toBe('dark');
    expect(embedModeFromSearch('?embed=1')).toBe('light');
    expect(embedModeFromSearch('?embed=1&theme=%3Cscript%3E')).toBe('light');
  });
});

describe('embedSnippet: absent config emits nothing (AC6)', () => {
  it('light is byte-identical to today\'s snippet', () => {
    expect(embedSnippet('https://app.example', 'tok')).toBe(
      '<iframe src="https://app.example/f/tok?embed=1" width="100%" height="600" style="border:0"></iframe>',
    );
    expect(embedSnippet('https://app.example', 'tok', 'light')).toBe(embedSnippet('https://app.example', 'tok'));
  });
  it('dark adds exactly one param', () => {
    expect(embedSnippet('https://app.example', 'tok', 'dark')).toContain('?embed=1&theme=dark"');
  });
});

describe('there is no third state (Otto, #721 AC1)', () => {
  it('offers exactly Light and Dark, and no "follow the visitor" option', () => {
    expect(EMBED_MODES).toEqual(['light', 'dark']);
    expect(Object.values(EMBED_MODE_LABELS).join(' ')).not.toMatch(/visitor|device|auto|system/i);
  });
});

/**
 * The pre-paint script is a STRING that runs before React, so a unit test of the
 * pure function proves nothing about it. This EXECUTES the real string against a
 * fake browser, for every combination, and compares it to `resolveEmbedTheme` —
 * so the two cannot drift apart unnoticed.
 */
function runInit(opts: { path: string; search: string; prefersDark: boolean; stored?: string }) {
  const attrs: Record<string, string> = {};
  const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
  const location = { pathname: opts.path, search: opts.search };
  const win = { matchMedia: () => ({ matches: opts.prefersDark }) };
  const localStorage = { getItem: () => opts.stored ?? null };
  new Function('document', 'location', 'window', 'localStorage', THEME_INIT_SCRIPT.replace(/window\.matchMedia/g, 'window.matchMedia'))(
    document,
    location,
    win,
    localStorage,
  );
  // The script calls the bare global `window`; a Function scope with the parameter above covers it.
  return attrs;
}

describe('THEME_INIT_SCRIPT, executed (#721)', () => {
  const modes = ['', '&theme=light', '&theme=dark', '&theme=auto', '&theme=nonsense', '&theme=DARK'];
  for (const q of modes) {
    for (const prefersDark of [false, true]) {
      it(`embed ${q || '(no theme param)'} on a ${prefersDark ? 'dark' : 'light'} device agrees with resolveEmbedTheme`, () => {
        const search = `?embed=1${q}`;
        const attrs = runInit({ path: '/f/abc', search, prefersDark });
        expect(attrs['data-theme']).toBe(embedModeFromSearch(search));
        expect(attrs['data-embed']).toBe('1');
      });
    }
  }

  it('the visitor\'s device NEVER changes an embed: same result on a light and a dark device', () => {
    for (const q of modes) {
      const search = `?embed=1${q}`;
      expect(runInit({ path: '/f/abc', search, prefersDark: true })['data-theme']).toBe(
        runInit({ path: '/f/abc', search, prefersDark: false })['data-theme'],
      );
    }
  });

  it('AC6: an embed with NO param is light even for a dark-device visitor — phase 0 is untouched', () => {
    expect(runInit({ path: '/f/abc', search: '?embed=1', prefersDark: true })['data-theme']).toBe('light');
  });

  it('a visitor\'s own stored preference never reaches an embed', () => {
    const attrs = runInit({ path: '/f/abc', search: '?embed=1', prefersDark: true, stored: 'dark' });
    expect(attrs['data-theme']).toBe('light');
  });

  it('the param does nothing outside an embed: the standalone form and the app follow the visitor as before', () => {
    const standalone = runInit({ path: '/f/abc', search: '?theme=dark', prefersDark: false });
    expect(standalone['data-theme']).toBe('light');
    expect(standalone['data-embed']).toBeUndefined();
    expect(runInit({ path: '/w/x', search: '?embed=1&theme=dark', prefersDark: true })['data-theme']).toBe('dark');
  });
});
