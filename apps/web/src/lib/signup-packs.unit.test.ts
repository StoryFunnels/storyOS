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
