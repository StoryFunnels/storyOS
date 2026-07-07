import { describe, expect, it } from 'vitest';
import { validateRecordValues } from '@storyos/schemas';
import type { FieldDef } from '@storyos/schemas';

const defs: FieldDef[] = [
  { id: 'f-title', api_name: 'name', type: 'title', config: {} },
  { id: 'f-text', api_name: 'notes', type: 'text', config: {} },
  { id: 'f-num', api_name: 'estimate', type: 'number', config: {} },
  { id: 'f-check', api_name: 'done', type: 'checkbox', config: {} },
  { id: 'f-date', api_name: 'due', type: 'date', config: { include_time: false } },
  { id: 'f-datetime', api_name: 'at', type: 'date', config: { include_time: true } },
  { id: 'f-url', api_name: 'link', type: 'url', config: {} },
  { id: 'f-email', api_name: 'contact', type: 'email', config: {} },
  { id: 'f-sel', api_name: 'state', type: 'select', config: {}, option_ids: ['opt-a', 'opt-b'] },
  { id: 'f-multi', api_name: 'tags', type: 'multi_select', config: {}, option_ids: ['t1', 't2'] },
  { id: 'f-user', api_name: 'owner', type: 'user', config: {} },
  { id: 'f-users', api_name: 'crew', type: 'user', config: { multi: true } },
  { id: 'f-sys', api_name: 'created_at', type: 'created_at', config: {} },
  { id: 'f-rel', api_name: 'project', type: 'relation', config: {} },
];

const run = (input: Record<string, unknown>) => validateRecordValues(defs, input);

describe('validateRecordValues (MN-011)', () => {
  it('maps api_names to field ids and extracts title', () => {
    const r = run({ name: 'Task 1', notes: 'hi', estimate: 4, done: true });
    expect(r.issues).toEqual([]);
    expect(r.title).toBe('Task 1');
    expect(r.values).toEqual({ 'f-text': 'hi', 'f-num': 4, 'f-check': true });
  });

  it('rejects unknown fields, read-only system fields, and relation values', () => {
    const r = run({ nope: 1, created_at: 'x', project: 'rec-1' });
    expect(r.issues.map((i) => i.path)).toEqual(['values.nope', 'values.created_at', 'values.project']);
  });

  it('coerces numeric strings, rejects non-numeric', () => {
    expect(run({ estimate: '42.5' }).values['f-num']).toBe(42.5);
    expect(run({ estimate: 'many' }).issues[0]!.message).toContain('number');
  });

  it('normalizes dates per include_time config', () => {
    expect(run({ due: '2026-07-08' }).values['f-date']).toBe('2026-07-08');
    expect(run({ due: '2026-07-08T15:30:00Z' }).values['f-date']).toBe('2026-07-08');
    expect(run({ at: '2026-07-08T15:30:00Z' }).values['f-datetime']).toBe('2026-07-08T15:30:00.000Z');
    expect(run({ due: 'not a date' }).issues).toHaveLength(1);
  });

  it('validates url and email formats', () => {
    expect(run({ link: 'https://storyos.dev' }).issues).toEqual([]);
    expect(run({ link: 'notaurl' }).issues).toHaveLength(1);
    expect(run({ contact: 'a@b.co' }).issues).toEqual([]);
    expect(run({ contact: 'nope' }).issues).toHaveLength(1);
  });

  it('enforces select option existence and dedupes multi-select', () => {
    expect(run({ state: 'opt-a' }).values['f-sel']).toBe('opt-a');
    expect(run({ state: 'opt-x' }).issues[0]!.message).toContain('unknown option');
    expect(run({ tags: ['t1', 't1', 't2'] }).values['f-multi']).toEqual(['t1', 't2']);
    expect(run({ tags: ['t1', 'tX'] }).issues).toHaveLength(1);
  });

  it('handles single vs multi user fields', () => {
    expect(run({ owner: 'u1' }).values['f-user']).toBe('u1');
    expect(run({ owner: ['u1'] }).issues).toHaveLength(1);
    expect(run({ crew: ['u1', 'u2'] }).values['f-users']).toEqual(['u1', 'u2']);
    expect(run({ crew: 'u1' }).issues).toHaveLength(1);
  });

  it('passes explicit nulls through as clear markers', () => {
    const r = run({ notes: null, estimate: null });
    expect(r.issues).toEqual([]);
    expect(r.values).toEqual({ 'f-text': null, 'f-num': null });
  });
});
