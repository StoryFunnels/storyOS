/**
 * Ticket #1275 item 1 — the weight a record's title is drawn at wherever the title is the row's subject: board card,
 * table title cell, calendar event (month, week, agenda), calendar "Undated" chip and list row. It had drifted to 550
 * (board), 500 (table, calendar events), 400 (undated chip, list), so one record read as four different weights.
 *
 * The class is spelled out in full here, never assembled from pieces, so Tailwind's scanner finds it. Every surface
 * imports THIS constant; a surface that writes its own `font-medium` on a title is the defect coming back
 * (see record-title.unit.test.ts, which fails on exactly that).
 */
export const RECORD_TITLE_WEIGHT = 'font-[550]';
