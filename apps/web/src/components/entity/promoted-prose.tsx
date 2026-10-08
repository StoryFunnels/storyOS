'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { CellEditor } from '@/components/table-view/cells';
import type { Field } from '@/components/table-view/use-table-data';
import { cn } from '@/lib/utils';

// Eight lines of `text-reading` — 13px at 1.625 leading = 21.125px a line, so
// 169px, plus ~3px of slack so the eighth line is never shaved. Deliberately
// NOT tied to the 180-char promotion threshold in record-detail.tsx: that
// number decides WHERE a field renders, this one decides how much of it shows
// before "Show all". The button is gated on measured overflow, so the two
// cannot disagree.
//
// #792 — THIS CONSTANT IS DERIVED FROM THE READING LEADING, so --text-reading's
// line-height in globals.css is load-bearing beyond styling. Change it and this
// clamp silently shows the wrong number of lines: nothing fails to compile and
// no test catches it, because the only symptom is a clamp that lands mid-line.
// If the reading leading ever moves, re-derive this number in the same commit.
const CLAMP_PX = 172;

interface Member {
  id: string;
  name: string;
  image: string | null;
}

/**
 * #780 Rule 1 / #802 — a long text field promoted out of the grid into a titled
 * prose block. It must stay editable (a grid row is; this used to be a dead
 * <div>) and must only offer "Show all" when the content really is clipped.
 */
export function PromotedProse({
  ws,
  db,
  rec,
  field,
  text,
  members,
  readOnly,
  onCommit,
}: {
  ws: string;
  db: string;
  rec: string;
  field: Field;
  text: string;
  members: Member[];
  readOnly: boolean;
  onCommit: (field: Field, value: unknown) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // scrollHeight is the full content height even while overflow-hidden clips
  // it, so one measure answers "would this be clipped?" in both states.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > CLAMP_PX + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, editing]);

  // A promoted block is long by definition, so edit it in the multiline
  // editor CellEditor already has (#758) rather than a one-line input.
  const editorField: Field = { ...field, config: { ...field.config, multiline: true } };

  return (
    <div className="mt-6 max-w-[74ch]">
      <div className="mb-1.5 flex items-center gap-2">
        <h4 className="text-body font-semibold text-ink">{field.displayName}</h4>
        <span className="rounded border border-border-default px-1 font-mono text-micro text-muted">
          {text.length.toLocaleString()} chars
        </span>
      </div>
      {editing ? (
        <div className="relative border-l-2 border-border-default pl-3.5">
          <CellEditor
            ws={ws}
            db={db}
            rec={rec}
            field={editorField}
            value={text}
            members={members}
            onCommit={(next) => {
              setEditing(false);
              onCommit(field, next);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          <div
            ref={bodyRef}
            role={readOnly ? undefined : 'button'}
            tabIndex={readOnly ? undefined : 0}
            aria-label={readOnly ? undefined : `Edit ${field.displayName}`}
            onClick={readOnly ? undefined : () => setEditing(true)}
            onKeyDown={
              readOnly
                ? undefined
                : (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      setEditing(true);
                    }
                  }
            }
            style={!expanded ? { maxHeight: CLAMP_PX } : undefined}
            className={cn(
              'relative whitespace-pre-wrap border-l-2 border-border-default pl-3.5 text-reading text-ink-secondary',
              !expanded && 'overflow-hidden',
              !readOnly && 'cursor-text rounded-r-[var(--radius-control)] hover:bg-hover/50',
            )}
          >
            {text}
            {overflows && !expanded && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--bg-app)] to-transparent"
              />
            )}
          </div>
          {overflows && (
            <button
              type="button"
              className="mt-1 rounded px-1 text-label font-medium text-muted hover:bg-hover hover:text-ink"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
