import { describe, expect, it } from 'vitest';
import {
  isComparableType,
  normalizeKeyPart,
  planAutoLinks,
  recordKey,
  type AutoLinkConfig,
  type MatchRecord,
} from '../src/relations/auto-link';

const rec = (id: string, title: string, values: Record<string, unknown> = {}): MatchRecord => ({
  id,
  title,
  values,
});

describe('isComparableType (MN-085)', () => {
  it('accepts scalar text-like + title, rejects the rest', () => {
    for (const t of ['title', 'text', 'url', 'email', 'number', 'date']) expect(isComparableType(t)).toBe(true);
    for (const t of ['select', 'multi_select', 'user', 'relation', 'checkbox', 'rich_text', 'color'])
      expect(isComparableType(t)).toBe(false);
  });
});

describe('normalizeKeyPart', () => {
  it('trims and lowercases strings by default', () => {
    expect(normalizeKeyPart('  Acme@X.com ', false)).toBe('acme@x.com');
  });
  it('preserves case when case-sensitive', () => {
    expect(normalizeKeyPart('Acme', true)).toBe('Acme');
  });
  it('treats empty / whitespace / null as no-match (null)', () => {
    expect(normalizeKeyPart('', false)).toBeNull();
    expect(normalizeKeyPart('   ', false)).toBeNull();
    expect(normalizeKeyPart(null, false)).toBeNull();
    expect(normalizeKeyPart(undefined, false)).toBeNull();
  });
  it('stringifies finite numbers, rejects arrays/objects', () => {
    expect(normalizeKeyPart(42, false)).toBe('42');
    expect(normalizeKeyPart(['a'], false)).toBeNull();
    expect(normalizeKeyPart({ a: 1 }, false)).toBeNull();
  });
});

describe('recordKey', () => {
  const config: AutoLinkConfig = {
    conditions: [
      { fieldA: { id: 'fa1', type: 'email' }, fieldB: { id: 'fb1', type: 'email' } },
      { fieldA: { id: 'fa2', type: 'text' }, fieldB: { id: 'fb2', type: 'text' } },
    ],
    caseSensitive: false,
  };
  it('joins normalized parts for the given side', () => {
    const a = rec('a', 'A', { fa1: 'Bob@x.com', fa2: 'EU' });
    expect(recordKey(a, config, 'a')).toBe(['bob@x.com', 'eu'].join(String.fromCharCode(0)));
  });
  it('is null when any condition value is empty', () => {
    const a = rec('a', 'A', { fa1: 'bob@x.com', fa2: '' });
    expect(recordKey(a, config, 'a')).toBeNull();
  });
  it('reads the title column for a title field', () => {
    const titleCfg: AutoLinkConfig = {
      conditions: [{ fieldA: { id: 'x', type: 'title' }, fieldB: { id: 'y', type: 'title' } }],
      caseSensitive: false,
    };
    expect(recordKey(rec('a', 'Acme Corp'), titleCfg, 'a')).toBe('acme corp');
  });
});

describe('planAutoLinks — many_to_many', () => {
  const config: AutoLinkConfig = {
    conditions: [{ fieldA: { id: 'email', type: 'email' }, fieldB: { id: 'email', type: 'email' } }],
    caseSensitive: false,
  };
  it('links every matching B and dedups against existing pairs', () => {
    const a = [rec('a1', 'A1', { email: 'x@x.com' })];
    const b = [rec('b1', 'B1', { email: 'X@X.com' }), rec('b2', 'B2', { email: 'x@x.com' })];
    const plan = planAutoLinks(a, b, config, 'many_to_many', new Map(), new Set(['a1' + String.fromCharCode(0) + 'b1']));
    expect(plan.links).toEqual([{ fromId: 'a1', toId: 'b2', aTitle: 'A1', bTitle: 'B2' }]);
    expect(plan.unmatched).toBe(0);
  });
  it('counts unmatched when nothing matches', () => {
    const plan = planAutoLinks(
      [rec('a1', 'A1', { email: 'none@x.com' })],
      [rec('b1', 'B1', { email: 'x@x.com' })],
      config,
      'many_to_many',
      new Map(),
      new Set(),
    );
    expect(plan.links).toHaveLength(0);
    expect(plan.unmatched).toBe(1);
  });
});

describe('planAutoLinks — one_to_many cap', () => {
  const config: AutoLinkConfig = {
    conditions: [{ fieldA: { id: 'k', type: 'text' }, fieldB: { id: 'k', type: 'text' } }],
    caseSensitive: false,
  };
  it('links a unique match', () => {
    const plan = planAutoLinks(
      [rec('a1', 'A1', { k: 'red' })],
      [rec('b1', 'B1', { k: 'red' })],
      config,
      'one_to_many',
      new Map(),
      new Set(),
    );
    expect(plan.links).toEqual([{ fromId: 'a1', toId: 'b1', aTitle: 'A1', bTitle: 'B1' }]);
  });
  it('flags ambiguous when several targets match — never silently picks', () => {
    const plan = planAutoLinks(
      [rec('a1', 'A1', { k: 'red' })],
      [rec('b1', 'B1', { k: 'red' }), rec('b2', 'B2', { k: 'red' })],
      config,
      'one_to_many',
      new Map(),
      new Set(),
    );
    expect(plan.links).toHaveLength(0);
    expect(plan.ambiguous).toEqual(['a1']);
  });
  it('leaves an A that already has a link untouched', () => {
    const plan = planAutoLinks(
      [rec('a1', 'A1', { k: 'red' })],
      [rec('b1', 'B1', { k: 'red' })],
      config,
      'one_to_many',
      new Map([['a1', 1]]),
      new Set(),
    );
    expect(plan.links).toHaveLength(0);
    expect(plan.ambiguous).toHaveLength(0);
  });
});
