import { describe, expect, it } from 'vitest';
import { applyFieldDefaults, fieldDefaultValue } from '@storyos/schemas';

const NOW = new Date('2026-08-15T14:30:00.000Z');

describe('fieldDefaultValue (#203)', () => {
  it('returns undefined when the field has no default configured', () => {
    expect(fieldDefaultValue('checkbox', {}, NOW)).toBeUndefined();
    expect(fieldDefaultValue('date', {}, NOW)).toBeUndefined();
    expect(fieldDefaultValue('checkbox', null, NOW)).toBeUndefined();
  });

  it('defaults a checkbox only when configured true', () => {
    expect(fieldDefaultValue('checkbox', { default: true }, NOW)).toBe(true);
    // An explicit `false` default is the same as no default: the field is
    // already empty/false, so writing it would add noise for no behaviour.
    expect(fieldDefaultValue('checkbox', { default: false }, NOW)).toBeUndefined();
  });

  it('defaults a date-only field to a bare YYYY-MM-DD', () => {
    // Must NOT smuggle a time into a date-only column — every downstream
    // formatter reads the string shape to decide how to render it.
    expect(fieldDefaultValue('date', { default_today: true }, NOW)).toBe('2026-08-15');
  });

  it('defaults a date-time field to a full ISO timestamp', () => {
    expect(fieldDefaultValue('date', { default_today: true, include_time: true }, NOW)).toBe(
      '2026-08-15T14:30:00.000Z',
    );
  });

  it('has no default for types that do not support one', () => {
    for (const type of ['text', 'number', 'select', 'user', 'url']) {
      expect(fieldDefaultValue(type, { default: true, default_today: true }, NOW)).toBeUndefined();
    }
  });
});

describe('applyFieldDefaults (#203)', () => {
  const defs = [
    { api_name: 'done', type: 'checkbox', config: { default: true } },
    { api_name: 'due', type: 'date', config: { default_today: true } },
    { api_name: 'notes', type: 'text', config: {} },
  ];

  it('fills absent keys', () => {
    expect(applyFieldDefaults(defs, { name: 'Task' }, NOW)).toEqual({
      name: 'Task',
      done: true,
      due: '2026-08-15',
    });
  });

  it('never overrides a value the caller supplied', () => {
    const out = applyFieldDefaults(defs, { done: false, due: '2020-01-01' }, NOW);
    expect(out['done']).toBe(false);
    expect(out['due']).toBe('2020-01-01');
  });

  /**
   * The one that matters. A user who deliberately clears a defaulted checkbox on
   * the create form sends `null`; if the server treated that as "absent" it would
   * helpfully put the value back, and the user could never create an unchecked
   * record. Explicit null is an instruction, not a gap.
   */
  it('treats an explicit null as a deliberate empty, not a missing key', () => {
    const out = applyFieldDefaults(defs, { done: null, due: null }, NOW);
    expect(out['done']).toBeNull();
    expect(out['due']).toBeNull();
  });

  it('leaves the caller input object untouched', () => {
    const input = { name: 'Task' };
    applyFieldDefaults(defs, input, NOW);
    expect(input).toEqual({ name: 'Task' });
  });

  it('gives every record in one batch the same creation date', () => {
    const a = applyFieldDefaults(defs, {}, NOW);
    const b = applyFieldDefaults(defs, {}, NOW);
    expect(a['due']).toBe(b['due']);
  });
});
