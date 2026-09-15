import { describe, expect, it } from 'vitest';
import { isEmbeddedForm, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from './theme';

/**
 * #711 phase 0 — an embedded public form must not follow the VISITOR's OS.
 *
 * The rule has two implementations that must not drift: `isEmbeddedForm`, used
 * by the React provider, and the hand-written string in THEME_INIT_SCRIPT that
 * runs before hydration. Both are exercised here, the script by evaluating it
 * against a stubbed document rather than by reading it.
 */
describe('isEmbeddedForm', () => {
  it('matches an embedded public form', () => {
    expect(isEmbeddedForm('/f/abc123', '?embed=1')).toBe(true);
  });

  it('ignores a public form opened directly — that is a page, not a component of someone else’s', () => {
    expect(isEmbeddedForm('/f/abc123', '')).toBe(false);
  });

  it('does not match embed=1 on any other route', () => {
    expect(isEmbeddedForm('/w/ws/d/db/v/view', '?embed=1')).toBe(false);
  });

  it('does not match a path that merely starts with the letter f', () => {
    expect(isEmbeddedForm('/forms/abc', '?embed=1')).toBe(false);
    expect(isEmbeddedForm('/favicon.ico', '?embed=1')).toBe(false);
  });

  it('requires embed=1 exactly, not any embed value', () => {
    expect(isEmbeddedForm('/f/abc', '?embed=0')).toBe(false);
    expect(isEmbeddedForm('/f/abc', '?embed=true')).toBe(false);
  });

  it('tolerates other params around it', () => {
    expect(isEmbeddedForm('/f/abc', '?utm_source=x&embed=1&ref=y')).toBe(true);
  });
});

/** Runs the pre-paint script against a stubbed window/document and reports data-theme. */
function runInitScript(opts: {
  pathname: string;
  search: string;
  stored?: string | null;
  prefersDark?: boolean;
  /** Safari blocks storage in third-party iframes: getItem THROWS (AC6). */
  storageThrows?: boolean;
}): string | null {
  let attr: string | null = null;
  const documentStub = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        if (name === 'data-theme') attr = value;
      },
    },
  };
  const localStorageStub = {
    getItem: (k: string) => {
      if (opts.storageThrows) throw new DOMException('blocked', 'SecurityError');
      return k === THEME_STORAGE_KEY ? (opts.stored ?? null) : null;
    },
  };
  const windowStub = {
    matchMedia: () => ({ matches: opts.prefersDark ?? false }),
  };
  const locationStub = { pathname: opts.pathname, search: opts.search };

  // eslint-disable-next-line no-new-func
  new Function(
    'document',
    'localStorage',
    'window',
    'location',
    'URLSearchParams',
    THEME_INIT_SCRIPT,
  )(documentStub, localStorageStub, windowStub, locationStub, URLSearchParams);
  return attr;
}

describe('THEME_INIT_SCRIPT', () => {
  it('pins an embedded form to light even when the visitor’s OS is dark', () => {
    expect(
      runInitScript({ pathname: '/f/abc', search: '?embed=1', prefersDark: true }),
    ).toBe('light');
  });

  it('pins an embedded form to light even when the visitor explicitly chose dark for StoryOS', () => {
    expect(
      runInitScript({ pathname: '/f/abc', search: '?embed=1', stored: 'dark', prefersDark: true }),
    ).toBe('light');
  });

  it('leaves every other route following the visitor, so nothing else changes', () => {
    expect(runInitScript({ pathname: '/w/ws', search: '', prefersDark: true })).toBe('dark');
    expect(runInitScript({ pathname: '/w/ws', search: '', prefersDark: false })).toBe('light');
    expect(runInitScript({ pathname: '/w/ws', search: '', stored: 'dark' })).toBe('dark');
  });

  it('still follows the visitor on a public form opened directly', () => {
    expect(runInitScript({ pathname: '/f/abc', search: '', prefersDark: true })).toBe('dark');
  });

  /**
   * AC6. Safari blocks storage access in a third-party iframe, so getItem throws
   * and the empty catch swallows it. Before phase 0 that left data-theme unset —
   * which happened to look right, and is exactly why the bug read as flaky
   * across browsers. The embed check now runs BEFORE the storage read, so the
   * pin lands in Safari and Chrome alike.
   */
  it('pins light even when localStorage throws, as it does in a third-party iframe', () => {
    expect(
      runInitScript({
        pathname: '/f/abc',
        search: '?embed=1',
        prefersDark: true,
        storageThrows: true,
      }),
    ).toBe('light');
  });
});
