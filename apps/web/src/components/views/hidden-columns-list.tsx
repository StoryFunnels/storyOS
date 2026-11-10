'use client';

import { Eye } from 'lucide-react';
import { OptionChip } from '../table-view/cells';
import type { SelectOption } from '../table-view/use-table-data';
import { hiddenBoardColumns, showBoardColumn } from './board-columns';

/**
 * #1182 — the hidden columns of a board, each with a Show. It lives in the Display menu's Grouping section,
 * beside the Group by it belongs to: the ids are options of THAT field. Renders nothing while no column is
 * hidden, so a board that never hid one looks exactly as it did.
 *
 * Each row is the shared `OptionChip` (the same chip a cell draws), never a re-drawn swatch. The list is read
 * through `hiddenBoardColumns`, so an id naming an option that no longer exists is not listed and cannot be
 * "shown": it is dropped the next time anything is saved (`showBoardColumn` re-saves only live ids).
 */
export function HiddenColumnsList({
  options,
  hiddenOptionIds,
  onChange,
  sectionClass,
  readOnly = false,
}: {
  /** The group-by field's options, in the field's own order. */
  options: SelectOption[];
  hiddenOptionIds: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  sectionClass: string;
  /** A viewer cannot save the view, so Show would look live and not stick: the list stays as information only. */
  readOnly?: boolean;
}) {
  const hidden = hiddenBoardColumns(options, hiddenOptionIds);
  if (hidden.length === 0) return null;
  return (
    <>
      <span className={sectionClass}>Hidden columns</span>
      <ul className="flex flex-col" aria-label="Hidden columns">
        {hidden.map((option) => (
          <li key={option.id} className="flex items-center justify-between gap-3 px-2 py-1 text-label text-ink">
            <span className="min-w-0 truncate">
              <OptionChip option={option} />
            </span>
            {!readOnly && (
            <button
              type="button"
              aria-label={`Show ${option.label}`}
              className="flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2 py-1.5 text-label text-muted hover:bg-hover hover:text-ink"
              onClick={() => onChange(showBoardColumn(options, hiddenOptionIds, option.id))}
            >
              <Eye className="h-3.5 w-3.5" />
              Show
            </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
