/**
 * Ticket #1277 (Otto's ruling, 2026-11-15) — where the record's Activity / Comments / About panel lives, by viewport width.
 *
 * From 900px the panel is the 344px column beside the fields (#780: the design's own breakpoint, deliberately not Tailwind's `lg:`).
 * Below 900px that column cannot fit, and until now it was simply hidden, so a phone had no way to reach comments or activity. Below
 * 900px the record now STACKS: fields first, then the same panel underneath after a hairline. The prototype draws it with the same
 * breakpoint, so 768-899px stacks too rather than keeping a hidden column.
 *
 * One number, used three ways: this helper, the media query that mounts exactly one of the two layouts, and the `min-[900px]` class on
 * the side column (a Tailwind class must be a literal, so `record-layout.unit.test.ts` pins that the literal and this constant agree).
 */
export const RECORD_SIDE_MIN_W = 900;

export type RecordLayoutMode = 'split' | 'stacked';

/** `split` = fields with the side column beside them; `stacked` = the panel under the fields. 900px and wider is split. */
export function recordLayoutMode(width: number): RecordLayoutMode {
  return width >= RECORD_SIDE_MIN_W ? 'split' : 'stacked';
}

/** The media query for `split`, derived from the same constant. */
export const RECORD_SPLIT_QUERY = `(min-width: ${RECORD_SIDE_MIN_W}px)`;

export type RecordPanelTab = 'activity' | 'comments' | 'about';

export const RECORD_PANEL_TABS: ReadonlyArray<{ value: RecordPanelTab; label: string }> = [
  { value: 'activity', label: 'Activity' },
  { value: 'comments', label: 'Comments' },
  { value: 'about', label: 'About' },
];
