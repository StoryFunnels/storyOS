import { describe, expect, it } from 'vitest';
import { getJsonPath } from './json-path';

describe('getJsonPath (MN-254)', () => {
  it('reads a nested object path', () => {
    expect(getJsonPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
  });

  it('reads an array index mid-path', () => {
    expect(getJsonPath({ items: [{ name: 'first' }, { name: 'second' }] }, 'items.1.name')).toBe(
      'second',
    );
  });

  it('reads a top-level array by index', () => {
    expect(getJsonPath([{ x: 1 }, { x: 2 }], '1.x')).toBe(2);
  });

  it('returns the root value for a single segment', () => {
    expect(getJsonPath({ name: 'Tally' }, 'name')).toBe('Tally');
  });

  it('returns undefined for a missing key', () => {
    expect(getJsonPath({ a: 1 }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when indexing past the end of an array', () => {
    expect(getJsonPath({ items: [1, 2] }, 'items.5')).toBeUndefined();
  });

  it('returns undefined for a non-numeric segment on an array', () => {
    expect(getJsonPath({ items: [1, 2] }, 'items.name')).toBeUndefined();
  });

  it('returns undefined when the path walks through null', () => {
    expect(getJsonPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when descending into a primitive', () => {
    expect(getJsonPath({ a: 'hello' }, 'a.b')).toBeUndefined();
  });

  it('returns undefined for an empty path', () => {
    expect(getJsonPath({ a: 1 }, '')).toBeUndefined();
  });

  it('returns undefined for a path of only dots', () => {
    expect(getJsonPath({ a: 1 }, '...')).toBeUndefined();
  });

  it('tolerates stray whitespace around segments', () => {
    expect(getJsonPath({ a: { b: 1 } }, ' a . b ')).toBe(1);
  });

  it('preserves value types (numbers, booleans, objects) rather than stringifying', () => {
    expect(getJsonPath({ score: 42, ok: true, meta: { x: 1 } }, 'score')).toBe(42);
    expect(getJsonPath({ score: 42, ok: true }, 'ok')).toBe(true);
    expect(getJsonPath({ meta: { x: 1 } }, 'meta')).toEqual({ x: 1 });
  });
});
