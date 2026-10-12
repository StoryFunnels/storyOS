import { describe, expect, it } from 'vitest';
import { assetUrl } from './asset-url';

describe('assetUrl (ticket #855)', () => {
  it('accepts the plain string this repo\'s build returns', () => {
    expect(assetUrl('/_next/static/media/figtree-latin.abc.woff2')).toBe('/_next/static/media/figtree-latin.abc.woff2');
  });
  it('accepts the { src } shape other bundlers return', () => {
    expect(assetUrl({ src: '/x.woff2', height: 1 })).toBe('/x.woff2');
  });
  it('throws on anything without a URL, instead of letting a hint ship with no href', () => {
    for (const bad of [undefined, null, '', {}, { src: '' }, { src: 3 }, 42]) expect(() => assetUrl(bad)).toThrow(/assetUrl/);
  });
});
