import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNTITLED_SPACE, consumeNewSpace, markNewSpace } from './new-space-focus';

function stubStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
}
afterEach(() => vi.unstubAllGlobals());

describe('new space name focus (#1094)', () => {
  it('is true once for the id that was marked, then false (a reload or back never re-focuses)', () => {
    stubStorage();
    markNewSpace('s1');
    expect(consumeNewSpace('s1')).toBe(true);
    expect(consumeNewSpace('s1')).toBe(false);
  });
  it('is false for any other space, and does not consume the mark (opening an existing space never edits its name)', () => {
    stubStorage();
    markNewSpace('s1');
    expect(consumeNewSpace('s2')).toBe(false);
    expect(consumeNewSpace('s1')).toBe(true);
  });
  it('is false when nothing was marked (a pack or template that makes a space never marks)', () => {
    stubStorage();
    expect(consumeNewSpace('s1')).toBe(false);
  });
  it('survives blocked storage: nothing throws', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    expect(() => markNewSpace('s1')).not.toThrow();
    expect(consumeNewSpace('s1')).toBe(false);
  });
  it('the default name is the one the page promises', () => {
    expect(UNTITLED_SPACE).toBe('Untitled space');
  });
});
