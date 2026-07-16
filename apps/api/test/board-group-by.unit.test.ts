import { describe, expect, it } from 'vitest';
import { boardGroupError } from '../src/views/views.service';

/**
 * MN-079: a board column per value only makes sense when a record holds exactly
 * one value. Anything multi-valued would put one card in several columns.
 */
describe('boardGroupError', () => {
  const select = { type: 'select', config: {} };
  const oneUser = { type: 'user', config: {} };
  const multiUser = { type: 'user', config: { multi: true } };
  const relationA = { type: 'relation', config: { relation_id: 'r1', side: 'a' } };
  const relationB = { type: 'relation', config: { relation_id: 'r1', side: 'b' } };
  const oneToMany = { cardinality: 'one_to_many' };
  const manyToMany = { cardinality: 'many_to_many' };

  it('allows a select field', () => {
    expect(boardGroupError(select, null)).toBeNull();
  });

  it('allows a single user field, rejects a multi-user one', () => {
    expect(boardGroupError(oneUser, null)).toBeNull();
    expect(boardGroupError(multiUser, null)).toMatch(/multi-user/);
  });

  it('allows the single side of a one-to-many relation — the case the ticket needs', () => {
    expect(boardGroupError(relationA, oneToMany)).toBeNull();
  });

  it('rejects the many side of a one-to-many relation', () => {
    expect(boardGroupError(relationB, oneToMany)).toMatch(/single side/);
  });

  it('rejects a many-to-many relation', () => {
    expect(boardGroupError(relationA, manyToMany)).toMatch(/single side/);
  });

  it('rejects a relation whose relation row is gone', () => {
    expect(boardGroupError(relationA, null)).toMatch(/no longer exists/);
  });

  it('rejects other field types by name', () => {
    expect(boardGroupError({ type: 'multi_select', config: {} }, null)).toMatch(/"multi_select"/);
    expect(boardGroupError({ type: 'text', config: {} }, null)).toMatch(/"text"/);
  });

  it('rejects a missing field', () => {
    expect(boardGroupError(undefined, null)).toMatch(/require group_by_field_id/);
  });
});
