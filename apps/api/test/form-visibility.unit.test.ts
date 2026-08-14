import { describe, expect, it } from 'vitest';
import { isFormFieldVisible, visibleFormFields } from '@storyos/schemas';
import type { PublicFormVisibilityRule } from '@storyos/schemas';

/**
 * #263 — the shared visibility evaluator. It lives in `schemas` because BOTH the
 * public renderer and the submit path run it; these tests are the contract that
 * keeps them agreeing. The loose-equality and blank cases are the ones that
 * decide whether a rule fires at all, so they carry most of the weight here.
 */
describe('isFormFieldVisible', () => {
  const rule = (over: Partial<PublicFormVisibilityRule>): PublicFormVisibilityRule => ({
    field: 'plan',
    op: 'eq',
    ...over,
  });

  it('shows a field with no rule at all — unconfigured is not hidden', () => {
    expect(isFormFieldVisible(undefined, {})).toBe(true);
  });

  it('treats an unanswered controlling field as blank rather than throwing', () => {
    expect(isFormFieldVisible(rule({ op: 'is_empty' }), {})).toBe(true);
    expect(isFormFieldVisible(rule({ op: 'not_empty' }), {})).toBe(false);
  });

  it('counts whitespace-only text and an empty array as blank', () => {
    expect(isFormFieldVisible(rule({ op: 'is_empty' }), { plan: '   ' })).toBe(true);
    expect(isFormFieldVisible(rule({ op: 'is_empty' }), { plan: [] })).toBe(true);
    expect(isFormFieldVisible(rule({ op: 'not_empty' }), { plan: ['a'] })).toBe(true);
  });

  it('matches eq / neq on a plain value', () => {
    expect(isFormFieldVisible(rule({ value: 'pro' }), { plan: 'pro' })).toBe(true);
    expect(isFormFieldVisible(rule({ value: 'pro' }), { plan: 'free' })).toBe(false);
    expect(isFormFieldVisible(rule({ op: 'neq', value: 'pro' }), { plan: 'free' })).toBe(true);
  });

  it('matches a single-select that submits a one-element array', () => {
    // The same rule has to work whichever shape the surface sends, or it would
    // appear to do nothing on one of them.
    expect(isFormFieldVisible(rule({ value: 'pro' }), { plan: ['pro'] })).toBe(true);
    expect(isFormFieldVisible(rule({ value: ['pro'] }), { plan: 'pro' })).toBe(true);
  });

  it('compares numbers and numeric strings as equal', () => {
    expect(isFormFieldVisible(rule({ field: 'qty', value: '3' }), { qty: 3 })).toBe(true);
  });

  it('does not treat null and undefined as equal to a real value', () => {
    expect(isFormFieldVisible(rule({ value: 'pro' }), { plan: null })).toBe(false);
  });

  it('matches `in` against both a scalar and a multi-select array', () => {
    const r = rule({ op: 'in', value: ['pro', 'business'] });
    expect(isFormFieldVisible(r, { plan: 'business' })).toBe(true);
    expect(isFormFieldVisible(r, { plan: ['free', 'pro'] })).toBe(true);
    expect(isFormFieldVisible(r, { plan: 'free' })).toBe(false);
  });
});

describe('visibleFormFields', () => {
  const f = (api_name: string, visible_when?: PublicFormVisibilityRule) => ({ api_name, visible_when });

  it('keeps unconditional fields in order', () => {
    expect(visibleFormFields([f('a'), f('b')], {}).map((x) => x.api_name)).toEqual(['a', 'b']);
  });

  it('drops a field whose rule does not match', () => {
    const fields = [f('plan'), f('seats', { field: 'plan', op: 'eq', value: 'pro' })];
    expect(visibleFormFields(fields, { plan: 'free' }).map((x) => x.api_name)).toEqual(['plan']);
    expect(visibleFormFields(fields, { plan: 'pro' }).map((x) => x.api_name)).toEqual(['plan', 'seats']);
  });

  it('hides a field whose CONTROLLER is itself hidden, so a two-step branch cannot leak', () => {
    // seats depends on plan; billing depends on seats. With plan=free, seats is
    // hidden — billing must not appear just because `seats` happens to be blank.
    const fields = [
      f('plan'),
      f('seats', { field: 'plan', op: 'eq', value: 'pro' }),
      f('billing', { field: 'seats', op: 'is_empty' }),
    ];
    expect(visibleFormFields(fields, { plan: 'free' }).map((x) => x.api_name)).toEqual(['plan']);
  });

  it('reveals the second step once the first is answered', () => {
    const fields = [
      f('plan'),
      f('seats', { field: 'plan', op: 'eq', value: 'pro' }),
      f('billing', { field: 'seats', op: 'not_empty' }),
    ];
    expect(visibleFormFields(fields, { plan: 'pro', seats: 5 }).map((x) => x.api_name)).toEqual([
      'plan',
      'seats',
      'billing',
    ]);
  });

  it('ignores a rule pointing at a LATER field — it can never have been answered', () => {
    const fields = [f('a', { field: 'z', op: 'not_empty' }), f('z')];
    expect(visibleFormFields(fields, { z: 'answered' }).map((x) => x.api_name)).toEqual(['z']);
  });
});
