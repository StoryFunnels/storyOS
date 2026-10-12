import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stepIndex } from './list-nav';

describe('stepIndex (#838)', () => {
  it('moves one step either way inside the list', () => {
    expect(stepIndex(0, 1, 5)).toBe(1);
    expect(stepIndex(3, -1, 5)).toBe(2);
  });
  it('wraps at both ends — the behaviour the ⌘K palette already had', () => {
    expect(stepIndex(4, 1, 5)).toBe(0);
    expect(stepIndex(0, -1, 5)).toBe(4);
  });
  it('stays defined on an empty or single-item list', () => {
    expect(stepIndex(0, 1, 0)).toBe(0);
    expect(stepIndex(3, -1, 0)).toBe(0);
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, -1, 1)).toBe(0);
  });
});

describe('one stepping rule, two surfaces (#838 AC2)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  it('the palette and the find box both call stepIndex instead of carrying their own modular maths', () => {
    for (const rel of ['../components/command-palette.tsx', '../components/views/view-search-box.tsx']) {
      const src = read(rel);
      expect(src, rel).toContain("from '@/lib/list-nav'");
      expect(src, rel).not.toMatch(/\+ rows\.length\) % rows\.length|\+ matches\.length\) % matches\.length/);
    }
  });
});
