import { describe, expect, it } from 'vitest';
import {
  calendarDescriptionText,
  calendarEventDates,
  googleEventEnd,
  googleEventStart,
} from './calendar-sync.service';

describe('Google Calendar event mapping (#20)', () => {
  it('maps a date-only record to an all-day event with an exclusive end', () => {
    expect(calendarEventDates('2026-07-24', undefined)).toEqual({
      start: { date: '2026-07-24' },
      end: { date: '2026-07-25' },
    });
    expect(calendarEventDates('2026-07-24', '2026-07-26')).toEqual({
      start: { date: '2026-07-24' },
      end: { date: '2026-07-27' },
    });
  });

  it('defaults timed events to one hour and refuses an end before the start', () => {
    expect(calendarEventDates('2026-07-24T09:00:00Z', undefined)).toEqual({
      start: { dateTime: '2026-07-24T09:00:00.000Z' },
      end: { dateTime: '2026-07-24T10:00:00.000Z' },
    });
    expect(calendarEventDates('2026-07-24T09:00:00Z', '2026-07-24T08:00:00Z')).toEqual({
      start: { dateTime: '2026-07-24T09:00:00.000Z' },
      end: { dateTime: '2026-07-24T10:00:00.000Z' },
    });
    expect(calendarEventDates('2026-07-24T00:00:00.000Z', undefined)).toEqual({
      start: { dateTime: '2026-07-24T00:00:00.000Z' },
      end: { dateTime: '2026-07-24T01:00:00.000Z' },
    });
    expect(calendarEventDates('2026-07-24T00:00:00.000Z', undefined, true)).toEqual({
      start: { date: '2026-07-24' },
      end: { date: '2026-07-25' },
    });
  });

  it('flattens a rich-text field into a Google event description', () => {
    expect(
      calendarDescriptionText([
        { type: 'paragraph', content: [{ type: 'text', text: 'Client kickoff' }] },
      ]),
    ).toContain('Client kickoff');
    expect(calendarDescriptionText('Plain notes')).toBe('Plain notes');
    expect(calendarDescriptionText(null)).toBeUndefined();
  });

  it('maps Google event dates back to StoryOS and makes all-day ends inclusive', () => {
    expect(
      googleEventStart({
        id: 'event-1',
        start: { date: '2026-07-24' },
      }),
    ).toBe('2026-07-24');
    expect(
      googleEventEnd({
        id: 'event-1',
        end: { date: '2026-07-27' },
      }),
    ).toBe('2026-07-26');
    expect(
      googleEventEnd({
        id: 'event-2',
        end: { dateTime: '2026-07-24T10:00:00Z' },
      }),
    ).toBe('2026-07-24T10:00:00Z');
  });
});
