import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StyleNonceProvider, applyBundlerNonce } from './style-nonce';

/**
 * Ticket #1340: Radix's scroll lock injects a <style> that takes its nonce from `__webpack_nonce__`. If the provider stops setting
 * it, every dropdown/dialog open is a style-src-elem violation again and the scroll-bar compensation silently stops applying.
 */
type G = { __webpack_nonce__?: string };
const g = globalThis as unknown as G & { window?: unknown };

afterEach(() => {
  delete g.__webpack_nonce__;
  vi.unstubAllGlobals();
});

describe('applyBundlerNonce (ticket #1340)', () => {
  it('sets the global the style libraries read, on the client', () => {
    vi.stubGlobal('window', {});
    applyBundlerNonce('req-nonce');
    expect(g.__webpack_nonce__).toBe('req-nonce');
  });

  it('does nothing on the server, and nothing without a nonce', () => {
    applyBundlerNonce('req-nonce');
    expect(g.__webpack_nonce__).toBeUndefined();
    vi.stubGlobal('window', {});
    applyBundlerNonce(undefined);
    expect(g.__webpack_nonce__).toBeUndefined();
  });

  it('is done by the provider itself, before its children render', () => {
    vi.stubGlobal('window', {});
    let seen: string | undefined;
    const Probe = () => {
      seen = g.__webpack_nonce__;
      return null;
    };
    renderToStaticMarkup(createElement(StyleNonceProvider, { nonce: 'n-1', children: createElement(Probe) }));
    expect(seen).toBe('n-1');
  });
});
