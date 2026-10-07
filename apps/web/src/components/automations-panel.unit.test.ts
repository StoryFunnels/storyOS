import { describe, expect, it } from 'vitest';
import { buildAutomationTrigger } from './automations-panel';

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
