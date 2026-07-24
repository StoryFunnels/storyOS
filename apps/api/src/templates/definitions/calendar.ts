import type { TemplateDef } from '../types';

/**
 * A database-scoped template used by the Google Calendar setup flow. Keep the
 * field keys stable: the installer returns their ids so setup can pre-map them
 * without guessing from display names or generated API slugs.
 */
export const calendarDatabase: TemplateDef = {
  slug: 'calendar',
  name: 'Calendar',
  description: 'A ready-to-sync event calendar with dates, notes, status and location.',
  category: 'marketing',
  scope: 'database',
  guide: `## Calendar database

Use **Start** and **End** for the event time, and **Description** for the body sent to Google Calendar.
The Calendar view is the planning surface; the table view is useful for bulk edits and filtering.`,
  databases: [
    {
      key: 'calendar',
      name: 'Calendar',
      icon: '🗓️',
      fields: [
        { key: 'start', display_name: 'Start', type: 'date', config: { include_time: true } },
        { key: 'end', display_name: 'End', type: 'date', config: { include_time: true } },
        { key: 'description', display_name: 'Description', type: 'rich_text' },
        {
          key: 'status',
          display_name: 'Status',
          type: 'select',
          options: [
            { label: 'Planned', color: 'gray' },
            { label: 'Confirmed', color: 'blue' },
            { label: 'Done', color: 'green' },
            { label: 'Cancelled', color: 'brown' },
          ],
        },
        { key: 'location', display_name: 'Location', type: 'text' },
      ],
    },
  ],
  relations: [],
  views: [
    { database: 'calendar', name: 'Calendar', type: 'calendar', date_field: 'start' },
    {
      database: 'calendar',
      name: 'Upcoming events',
      type: 'table',
      sorts: [{ field: 'start', direction: 'asc' }],
    },
  ],
  records: [],
};
