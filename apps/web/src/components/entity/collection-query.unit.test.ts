import { describe, expect, it } from 'vitest';
import { collectionQueryView } from './collection-query';

/** Colour-by paints rows; it must not be part of the related-records query key. */
describe('collectionQueryView', () => {
  const cv = { filters: { and: [{ field: 'state', op: 'eq', value: 'x' }] }, sorts: [{ field: 'priority', direction: 'asc' }], color_by: 'state' };
  it('two colour choices make the same query key', () => {
    expect(JSON.stringify(collectionQueryView(cv))).toBe(JSON.stringify(collectionQueryView({ ...cv, color_by: 'priority' })));
    expect(JSON.stringify(collectionQueryView(cv))).toBe(JSON.stringify(collectionQueryView({ ...cv, color_by: undefined })));
  });
  it('a filter or sort change still makes a new key', () => {
    expect(JSON.stringify(collectionQueryView(cv))).not.toBe(JSON.stringify(collectionQueryView({ ...cv, sorts: [] })));
  });
});
