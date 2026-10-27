import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeNewDocument, markNewDocument } from './new-doc-focus';

function stubStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
}
afterEach(() => vi.unstubAllGlobals());

describe('new document focus (#1090)', () => {
  it('is true once for the id that was marked, then false (a reload or back never re-focuses)', () => {
    stubStorage();
    markNewDocument('d1');
    expect(consumeNewDocument('d1')).toBe(true);
    expect(consumeNewDocument('d1')).toBe(false);
  });
  it('is false for any other document, and does not consume the mark', () => {
    stubStorage();
    markNewDocument('d1');
    expect(consumeNewDocument('d2')).toBe(false);
    expect(consumeNewDocument('d1')).toBe(true);
  });
  it('is false when nothing was marked (a template or pack install never marks, so it cannot steal focus)', () => {
    stubStorage();
    expect(consumeNewDocument('d1')).toBe(false);
  });
  it('survives blocked storage: nothing throws, the document just is not focused', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    expect(() => markNewDocument('d1')).not.toThrow();
    expect(consumeNewDocument('d1')).toBe(false);
  });
  it('is wired at both creators and consumed by the document page', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    expect(read('../components/sidebar.tsx')).toMatch(/markNewDocument\(d\.id\);\s*router\.push\(`\/w\/\$\{ws\}\/doc\//);
    expect(read('../components/personal-section.tsx')).toMatch(/markNewDocument\(d\.id\);\s*router\.push\(`\/w\/\$\{ws\}\/doc\//);
    expect(read('../components/personal-section.tsx')).toMatch(/router\.push\(`\/w\/\$\{ws\}\/d\/\$\{vars\.databaseId\}\?view=\$\{v\.id\}`\)/);
    expect(read('../app/w/[ws]/doc/[doc]/page.tsx')).toMatch(/consumeNewDocument\(doc\)\) return;[\s\S]*titleRef\.current\?\.focus\(\);\s*titleRef\.current\?\.select\(\)/);
  });
});
