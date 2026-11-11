import { describe, expect, it } from 'vitest';
import type { RecordTemplate } from '@storyos/schemas';
import { hasTemplateMenu, readApplied, skippedMessage, templateRowHint } from './record-templates';

const tpl = (over: Partial<RecordTemplate> = {}): RecordTemplate => ({
  id: '11111111-1111-4111-8111-111111111111',
  database_id: '22222222-2222-4222-8222-222222222222',
  name: 'Bug',
  description: null,
  values: {},
  body: null,
  origin: 'user',
  created_at: '2026-11-11T00:00:00Z',
  updated_at: '2026-11-11T00:00:00Z',
  ...over,
});

describe('hasTemplateMenu (unconfigured is not invalid)', () => {
  it('keeps plain New for a database with no templates', () => {
    expect(hasTemplateMenu([])).toBe(false);
  });
  it('keeps plain New while the list is loading or failed', () => {
    expect(hasTemplateMenu(undefined)).toBe(false);
  });
  it('offers the menu as soon as one template exists', () => {
    expect(hasTemplateMenu([tpl()])).toBe(true);
  });
});

describe('templateRowHint', () => {
  it('prefers the description', () => {
    expect(templateRowHint(tpl({ description: ' Steps to reproduce ', origin: 'pack' }))).toBe('Steps to reproduce');
  });
  it('marks an undescribed pack template and leaves a user one blank', () => {
    expect(templateRowHint(tpl({ origin: 'pack' }))).toBe('From a pack');
    expect(templateRowHint(tpl({ description: '   ' }))).toBe('');
  });
});

describe('readApplied (the rejection paths)', () => {
  it('reads the new record id and the skipped presets', () => {
    expect(readApplied({ record: { id: 'r1' }, skipped: [{ field: 'type', reason: 'gone' }] })).toEqual({
      id: 'r1',
      skipped: [{ field: 'type', reason: 'gone' }],
    });
  });
  it('treats a missing skipped list as none', () => {
    expect(readApplied({ record: { id: 'r1' } }).skipped).toEqual([]);
  });
  it.each([[undefined], [null], [{}], [{ record: {} }], [{ record: { id: '' } }], [{ record: { id: 7 } }]])(
    'throws rather than navigating to /r/undefined for %j',
    (body) => {
      expect(() => readApplied(body)).toThrow();
    },
  );
});

describe('skippedMessage', () => {
  it('says nothing when nothing was dropped', () => {
    expect(skippedMessage(undefined)).toBeNull();
    expect(skippedMessage([])).toBeNull();
  });
  it('names the one field, or counts several', () => {
    expect(skippedMessage([{ field: 'type', reason: 'x' }])).toContain('type');
    expect(skippedMessage([{ field: 'a', reason: 'x' }, { field: 'b', reason: 'y' }])).toContain('2 presets');
  });
});
