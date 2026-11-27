import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { buildAutomationTrigger, SavedScheduleSettings } from './automations-panel';

const base = {
  triggerType: 'record_created',
  triggerFieldId: '',
  relationFieldId: '',
  linkDirection: '' as const,
  every: 'day',
  at: '09:00',
};

describe('buildAutomationTrigger — #703 (record_linked round-trip)', () => {
  it('record_linked preserves relation_field_id and direction', () => {
    expect(
      buildAutomationTrigger({
        ...base,
        triggerType: 'record_linked',
        relationFieldId: 'field-1',
        linkDirection: 'link',
      }),
    ).toEqual({ type: 'record_linked', relation_field_id: 'field-1', direction: 'link' });
  });

  it('record_linked with no direction omits it rather than sending an empty string', () => {
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'record_linked', relationFieldId: 'field-1' }),
    ).toEqual({ type: 'record_linked', relation_field_id: 'field-1' });
  });

  it('record_linked with unlink direction round-trips', () => {
    expect(
      buildAutomationTrigger({
        ...base,
        triggerType: 'record_linked',
        relationFieldId: 'field-2',
        linkDirection: 'unlink',
      }),
    ).toEqual({ type: 'record_linked', relation_field_id: 'field-2', direction: 'unlink' });
  });

  it('record_created is unaffected (regression)', () => {
    expect(buildAutomationTrigger(base)).toEqual({ type: 'record_created' });
  });

  it('record_updated with a scoped field is unaffected (regression)', () => {
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'record_updated', triggerFieldId: 'field-3' }),
    ).toEqual({ type: 'record_updated', field_id: 'field-3' });
  });

  it('record_updated with "any field" omits field_id (regression)', () => {
    expect(buildAutomationTrigger({ ...base, triggerType: 'record_updated' })).toEqual({
      type: 'record_updated',
    });
  });

  it('schedule is unaffected (regression)', () => {
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'week', at: '14:30' }),
    ).toEqual({ type: 'schedule', every: 'week', at: '14:30' });
  });

  it('webhook_received is unaffected (regression)', () => {
    expect(buildAutomationTrigger({ ...base, triggerType: 'webhook_received' })).toEqual({
      type: 'webhook_received',
    });
  });
});

describe('schedule settings the editor has no control for — #1317', () => {
  const stored = {
    type: 'schedule',
    every: 'day',
    at: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    between: { from: '08:00', to: '18:00' },
    timezone: 'Europe/Vienna',
  };

  it('saving a loaded rule unchanged builds the identical stored trigger', () => {
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'day', at: '09:00', preserved: stored }),
    ).toEqual(stored);
  });

  it('a weekly rule keeps its weekday and zone', () => {
    const weekly = { type: 'schedule', every: 'week', at: '10:00', weekday: 2, timezone: 'Europe/Vienna' };
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'week', at: '10:00', preserved: weekly }),
    ).toEqual(weekly);
  });

  it('an every-N-minutes rule keeps its interval', () => {
    const mins = { type: 'schedule', every: 'minutes', minutes: 15, between: { from: '08:00', to: '18:00' } };
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'minutes', at: '09:00', preserved: mins }),
    ).toMatchObject({ minutes: 15, between: mins.between });
  });

  it('does not carry weekdays onto a weekly cadence the server would reject', () => {
    const out = buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'week', preserved: stored });
    expect(out).not.toHaveProperty('weekdays');
    expect(out).toMatchObject({ between: stored.between, timezone: 'Europe/Vienna' });
  });

  it('an hourly rule saved with no time does not gain one from the form default', () => {
    const hourly = { type: 'schedule', every: 'hour', weekdays: [1, 2], between: { from: '08:00', to: '18:00' }, timezone: 'Europe/Vienna' };
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'hour', at: '09:00', preserved: hourly }),
    ).toEqual(hourly);
  });

  it('a schedule with nothing extra stays minimal', () => {
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'day', at: '09:00', preserved: { type: 'schedule' } as never }),
    ).toEqual({ type: 'schedule', every: 'day', at: '09:00' });
  });

  it('the editor shows the saved window, days and zone read-only, in one sentence', () => {
    const html = renderToStaticMarkup(createElement(SavedScheduleSettings, { trigger: stored }));
    expect(html).toContain('Also set outside this editor, and kept when you save');
    expect(html).toContain('Mon-Fri');
    expect(html).toContain('between 08:00 and 18:00');
    expect(html).toContain('Europe/Vienna');
  });

  it('does not list the interval there: an every-N-minutes rule has its own box now', () => {
    const html = renderToStaticMarkup(createElement(SavedScheduleSettings, { trigger: { type: 'schedule', every: 'minutes', minutes: 45 } }));
    expect(html).toBe('');
  });

  // Ticket #1318 AC2 — opening a minutes rule and saving it untouched must not change it, whatever else it carries.
  it('saving an every-N-minutes rule unchanged keeps the interval and everything else', () => {
    const saved = { type: 'schedule', every: 'minutes', minutes: 45, weekdays: [1, 2, 3, 4, 5], between: { from: '09:00', to: '17:00' }, timezone: 'Europe/London' };
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'minutes', at: '09:00', minutes: 45, preserved: saved }),
    ).toEqual(saved);
    // ...and the same when the form never touched the box (no draft value): the saved interval carries through.
    expect(buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'minutes', at: '09:00', preserved: saved })).toEqual(saved);
  });

  it('a changed interval replaces the saved one, and only the interval', () => {
    const saved = { type: 'schedule', every: 'minutes', minutes: 45, between: { from: '09:00', to: '17:00' } };
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'minutes', at: '09:00', minutes: 20, preserved: saved }),
    ).toEqual({ ...saved, minutes: 20 });
  });

  it('switching a minutes rule to hourly drops the interval, which the server would reject there', () => {
    const saved = { type: 'schedule', every: 'minutes', minutes: 45 };
    expect(
      buildAutomationTrigger({ ...base, triggerType: 'schedule', every: 'hour', at: '09:00', minutes: 45, preserved: saved }),
    ).not.toHaveProperty('minutes');
  });

  it('shows nothing for a plain schedule or a non-schedule rule', () => {
    expect(renderToStaticMarkup(createElement(SavedScheduleSettings, { trigger: { type: 'schedule', every: 'day', at: '09:00' } }))).toBe('');
    expect(renderToStaticMarkup(createElement(SavedScheduleSettings, { trigger: { type: 'record_created' } }))).toBe('');
  });
});
