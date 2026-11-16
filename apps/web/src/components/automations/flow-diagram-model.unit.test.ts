import { describe, expect, it } from 'vitest';
import type { Field } from '@/components/table-view/use-table-data';
import { conditionLabel, deriveFlowDiagram, triggerLabel } from './flow-diagram-model';

const field = (id: string, displayName: string, apiName = id, type = 'text'): Field => ({
  id,
  apiName,
  displayName,
  type,
  config: {},
  isSystem: false,
});

const fields: Field[] = [
  {
    ...field('f-status', 'Status', 'status', 'workflow'),
    options: [
      { id: 'opt-active', label: 'Active', color: 'green' },
      { id: 'opt-closed', label: 'Closed', color: 'gray' },
    ],
  },
  field('f-owner', 'Owner', 'owner'),
  field('f-clients', 'Clients', 'clients'),
];

describe('triggerLabel (#283)', () => {
  it('names the field for record_updated', () => {
    expect(triggerLabel({ type: 'record_updated', field_id: 'f-status' }, fields)).toBe(
      'When "Status" changes',
    );
  });

  it('falls back to "a record" for an unscoped record_updated', () => {
    expect(triggerLabel({ type: 'record_updated' }, fields)).toBe('When a record changes');
  });

  it('reads a schedule with its cadence and time', () => {
    expect(triggerLabel({ type: 'schedule', every: 'day', at: '09:00' }, fields)).toBe(
      'Every day at 09:00 (server time)',
    );
    expect(triggerLabel({ type: 'schedule', every: 'hour' }, fields)).toBe('Every hour (server time)');
  });

  it('omits the time of day for hourly and minute cadences', () => {
    expect(triggerLabel({ type: 'schedule', every: 'hour', at: '09:00' }, fields)).toBe('Every hour (server time)');
    expect(triggerLabel({ type: 'schedule', every: 'minutes', minutes: 15, at: '09:00' }, fields)).toBe(
      'Every 15 minutes (server time)',
    );
    expect(triggerLabel({ type: 'schedule', every: 'minutes' }, fields)).toBe('Every few minutes (server time)');
  });

  it('names the weekday and the active window', () => {
    expect(triggerLabel({ type: 'schedule', every: 'week', at: '09:00', weekday: 1 }, fields)).toBe(
      'Every week on Mon at 09:00 (server time)',
    );
    expect(triggerLabel({ type: 'schedule', every: 'week', at: '09:00', weekday: 5 }, fields)).toBe(
      'Every week on Fri at 09:00 (server time)',
    );
    expect(
      triggerLabel(
        { type: 'schedule', every: 'minutes', minutes: 30, between: { from: '09:00', to: '17:00' }, weekdays: [1, 2, 3, 4, 5] },
        fields,
      ),
    ).toBe('Every 30 minutes, 09:00-17:00, Mon-Fri (server time)');
    expect(triggerLabel({ type: 'schedule', every: 'day', at: '09:00', weekdays: [6, 0, 1] }, fields)).toBe(
      'Every day at 09:00, Mon, Sat, Sun (server time)',
    );
  });

  it('reads a weekly schedule and names a non-default time zone', () => {
    expect(triggerLabel({ type: 'schedule', every: 'week', at: '09:00' }, fields)).toBe(
      'Every week at 09:00 (server time)',
    );
    expect(
      triggerLabel({ type: 'schedule', every: 'day', at: '09:00', timezone: 'Europe/Kyiv' }, fields),
    ).toBe('Every day at 09:00 (Europe/Kyiv)');
  });

  it('never prints "undefined" for a schedule without `every`', () => {
    const label = triggerLabel({ type: 'schedule' }, fields);
    expect(label).toBe('On a schedule (server time)');
    expect(label).not.toContain('undefined');
    expect(triggerLabel({ type: 'schedule', at: '09:00' }, fields)).toBe('On a schedule at 09:00 (server time)');
  });

  it('describes record_linked with its relation field and direction (#270)', () => {
    expect(
      triggerLabel({ type: 'record_linked', relation_field_id: 'f-clients', direction: 'link' }, fields),
    ).toBe('When a record is linked via "Clients"');
    expect(
      triggerLabel(
        { type: 'record_linked', relation_field_id: 'f-clients', direction: 'unlink' },
        fields,
      ),
    ).toBe('When a record is unlinked via "Clients"');
  });

  it('says "linked or unlinked" when record_linked has no direction', () => {
    expect(triggerLabel({ type: 'record_linked', relation_field_id: 'f-clients' }, fields)).toBe(
      'When a record is linked or unlinked via "Clients"',
    );
  });

  it('renders schedule with and without a time-of-day', () => {
    expect(triggerLabel({ type: 'schedule', every: 'day', at: '09:00' }, fields)).toBe(
      'Every day at 09:00 (server time)',
    );
    expect(triggerLabel({ type: 'schedule', every: 'hour' }, fields)).toBe('Every hour (server time)');
  });

  it('handles record_created and webhook_received', () => {
    expect(triggerLabel({ type: 'record_created' }, fields)).toBe('When a record is created');
    expect(triggerLabel({ type: 'webhook_received' }, fields)).toBe('A webhook is received');
  });

  it('renders an unrecognised trigger type honestly instead of throwing (AC #2)', () => {
    expect(triggerLabel({ type: 'some_future_trigger' }, fields)).toBe('some_future_trigger');
  });
});

describe('conditionLabel (#283)', () => {
  it('names the field and reads no-value ops without a dangling value', () => {
    expect(conditionLabel({ field: 'status', op: 'is_empty' }, fields)).toBe('"Status" is empty');
  });

  it('renders a value and joins an array value', () => {
    expect(conditionLabel({ field: 'owner', op: 'eq', value: 'me' }, fields)).toBe('"Owner" eq me');
    expect(conditionLabel({ field: 'status', op: 'is_any_of', value: ['a', 'b'] }, fields)).toBe(
      '"Status" is any of a, b',
    );
  });

  it('reads a relative date in words (ticket #1155), keeps an absolute one, and leaves an unknown token as written', () => {
    expect(conditionLabel({ field: 'due', op: 'before', value: '$date:-90d' }, fields)).toBe('due more than 90 days ago');
    expect(conditionLabel({ field: 'due', op: 'after', value: '$date:+3d' }, fields)).toBe('due more than 3 days from now');
    expect(conditionLabel({ field: 'due', op: 'before', value: '2026-07-31' }, fields)).toBe('due before 2026-07-31');
    expect(conditionLabel({ field: 'due', op: 'before', value: '$date:-ninety' }, fields)).toBe('due before $date:-ninety');
  });

  it('is null for no condition', () => {
    expect(conditionLabel(null, fields)).toBeNull();
    expect(conditionLabel(undefined, fields)).toBeNull();
  });

  it('resolves a select field\'s stored option id(s) to their label (#274 stores ids, not labels)', () => {
    expect(conditionLabel({ field: 'status', op: 'eq', value: ['opt-active'] }, fields)).toBe(
      '"Status" eq Active',
    );
    expect(
      conditionLabel({ field: 'status', op: 'is_any_of', value: ['opt-active', 'opt-closed'] }, fields),
    ).toBe('"Status" is any of Active, Closed');
  });

  it('falls back to the raw id for a select value with no matching option', () => {
    expect(conditionLabel({ field: 'status', op: 'eq', value: ['some-deleted-option'] }, fields)).toBe(
      '"Status" eq some-deleted-option',
    );
  });
});

describe('deriveFlowDiagram (#283)', () => {
  it('derives trigger, rule-level condition, and ordered actions', () => {
    const diagram = deriveFlowDiagram(
      {
        trigger: { type: 'record_updated', field_id: 'f-status' },
        condition: { field: 'owner', op: 'not_empty' },
        actions: [
          { type: 'add_comment' },
          { type: 'notify_user' },
        ],
      },
      fields,
    );
    expect(diagram.triggerLabel).toBe('When "Status" changes');
    expect(diagram.conditionLabel).toBe('"Owner" is not empty');
    expect(diagram.actions.map((a) => a.label)).toEqual(['Add a comment', 'Notify a person']);
    expect(diagram.actions.every((a) => a.recognized)).toBe(true);
  });

  it('draws a per-action condition as a branch, independent of the rule-level condition', () => {
    const diagram = deriveFlowDiagram(
      {
        trigger: { type: 'record_created' },
        condition: null,
        actions: [{ type: 'add_comment', condition: { field: 'status', op: 'eq', value: 'Done' } }],
      },
      fields,
    );
    expect(diagram.conditionLabel).toBeNull();
    expect(diagram.actions[0]!.branchLabel).toBe('"Status" eq Done');
  });

  it('flags create_records as a fan-out and everything else as not', () => {
    const diagram = deriveFlowDiagram(
      {
        trigger: { type: 'record_created' },
        actions: [{ type: 'create_records' }, { type: 'create_record' }],
      },
      fields,
    );
    expect(diagram.actions[0]!.fanOut).toBe(true);
    expect(diagram.actions[1]!.fanOut).toBe(false);
  });

  it('renders an unrecognised action type honestly instead of throwing (AC #2)', () => {
    const diagram = deriveFlowDiagram(
      { trigger: { type: 'record_created' }, actions: [{ type: 'some_future_action' }] },
      fields,
    );
    expect(diagram.actions[0]!.recognized).toBe(false);
    expect(diagram.actions[0]!.label).toBe('some future action');
  });
});
