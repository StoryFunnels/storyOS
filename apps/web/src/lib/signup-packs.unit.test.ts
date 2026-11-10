import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orderSignupPacks, signupPackLine } from './signup-packs';

const p = (slug: string) => ({ slug });

describe('orderSignupPacks', () => {
  it('puts the three starter packs first, in the featured order, then the rest in registry order', () => {
    const { featured, rest } = orderSignupPacks(
      ['agency-os', 'team-wiki', 'book-launch', 'team-board', 'dev-tracker', 'support-inbox'].map(p),
    );
    expect(featured.map((x) => x.slug)).toEqual(['team-board', 'dev-tracker', 'team-wiki']);
    expect(rest.map((x) => x.slug)).toEqual(['agency-os', 'book-launch', 'support-inbox']);
  });

  it('skips a featured pack the registry does not have, and drops nothing else', () => {
    const { featured, rest } = orderSignupPacks(['agency-os', 'team-wiki'].map(p));
    expect(featured.map((x) => x.slug)).toEqual(['team-wiki']);
    expect(rest.map((x) => x.slug)).toEqual(['agency-os']);
  });

  it('with no registry (slow or failed) returns nothing to draw, not a throw', () => {
    expect(orderSignupPacks([])).toEqual({ featured: [], rest: [] });
  });
});

describe('signupPackLine', () => {
  it('uses the manifest why', () => {
    expect(signupPackLine({ slug: 'a', name: 'A', summary: 'sum', why: ' Because. ' })).toBe('Because.');
  });
  it('falls back to the summary, then the name, never blank', () => {
    expect(signupPackLine({ slug: 'a', name: 'A', summary: 'sum', why: null })).toBe('sum');
    expect(signupPackLine({ slug: 'a', name: 'A', summary: '  ', why: '' })).toBe('A');
    expect(signupPackLine({ slug: 'a', name: 'A' })).toBe('A');
  });
});

describe('signup page wiring (#1150, source-level like space-start.unit.test)', () => {
  const page = readFileSync(join(__dirname, '../app/new-workspace/page.tsx'), 'utf8');
  it('opens on the "What are you working on?" step, not behind a link', () => {
    expect(page).toContain("useState<'describe' | 'template'>('template')");
  });
  it('draws featured packs first through orderSignupPacks, with no extra headings', () => {
    expect(page).toContain('[...featured, ...rest]');
    expect(page).not.toContain('More starting points');
    expect(page).not.toContain('Start ready to work');
  });
  it('wears the shared featured border instead of copying it', () => {
    expect(page).toContain('packCardBorder(pack.slug)');
  });
  it('keeps the loading, failed-registry retry and AI-build fallbacks', () => {
    expect(page).toContain('Loading starting points');
    expect(page).toContain('Try again');
    expect(page).toContain("setMode('describe')");
  });
});
