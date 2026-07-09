'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}
function fmtDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Forgiving parser: ISO, dd.mm.yyyy, dd/mm/yyyy, "jul 15" / "15 jul", today, tomorrow. */
export function parseDateText(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const today = new Date();
  if (text === 'today') return fmtDate(today);
  if (text === 'tomorrow') return fmtDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  if (text === 'yesterday') return fmtDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 ? fmtDate(d) : null;
  }
  m = /^(\d{1,2})[.//](\d{1,2})[.//](\d{4})$/.exec(text);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return d.getMonth() === Number(m[2]) - 1 ? fmtDate(d) : null;
  }
  const named =
    /^([a-z]{3,})\s+(\d{1,2})(?:,?\s*(\d{4}))?$/.exec(text) ??
    (() => {
      const alt = /^(\d{1,2})\s+([a-z]{3,})(?:,?\s*(\d{4}))?$/.exec(text);
      return alt ? [alt[0], alt[2], alt[1], alt[3]] : null;
    })();
  if (named) {
    const month = MONTHS.findIndex((name) => name.startsWith(named[1] as string));
    const day = Number(named[2]);
    if (month >= 0 && day >= 1 && day <= 31) {
      const year = named[3] ? Number(named[3]) : today.getFullYear();
      const d = new Date(year, month, day);
      return d.getMonth() === month ? fmtDate(d) : null;
    }
  }
  return null;
}

/**
 * One-click date popover (MN-038): text input with forgiving parsing on top,
 * month grid below (click commits), Clear/Today shortcuts, optional time row.
 */
export function DatePicker({
  value,
  includeTime = false,
  onCommit,
  onCancel,
}: {
  value: string | null;
  includeTime?: boolean;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initialDate = value ? String(value).slice(0, 10) : null;
  const initialTime = includeTime && value && String(value).length > 10 ? String(value).slice(11, 16) : '';

  const [text, setText] = useState(initialDate ?? '');
  const [time, setTime] = useState(initialTime);
  const [view, setView] = useState(() => {
    const base = initialDate ? new Date(initialDate) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  const selected = parseDateText(text);

  function commit(date: string | null) {
    if (date === null) return onCommit(null);
    onCommit(includeTime && time ? `${date}T${time}` : date);
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Outside click keeps whatever the input currently parses to.
        if (selected && selected !== initialDate) commit(selected);
        else if (includeTime && selected && time !== initialTime) commit(selected);
        else onCancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  });

  const grid = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const offset = (first.getDay() + 6) % 7; // Monday-first
    const start = new Date(view.year, view.month, 1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return d;
    });
  }, [view]);

  const todayStr = fmtDate(new Date());
  const monthLabel = `${MONTHS[view.month]![0]!.toUpperCase()}${MONTHS[view.month]!.slice(1, 3)} ${view.year}`;

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-0.5 w-64 rounded-[var(--radius-card)] border border-border-default bg-card p-2 shadow-[0_4px_12px_rgba(15,23,41,0.1)]"
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        placeholder="2026-07-15, 15.07, jul 15, today…"
        className={cn(
          'mb-1.5 w-full rounded-[var(--radius-control)] border bg-card px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint',
          text && !selected ? 'border-error' : 'border-border-default focus:border-border-strong',
        )}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseDateText(e.target.value);
          if (parsed) {
            const d = new Date(parsed);
            setView({ year: d.getFullYear(), month: d.getMonth() });
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (selected) commit(selected);
            else if (!text.trim()) commit(null);
          }
        }}
      />
      {includeTime && (
        <input
          type="time"
          className="mb-1.5 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-[13px] text-ink outline-none"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
      )}

      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[13px] font-medium text-ink">{monthLabel}</span>
        <span className="flex gap-0.5">
          <button type="button" className="rounded p-1 text-muted hover:bg-hover hover:text-ink" onClick={() => shiftMonth(-1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="rounded p-1 text-muted hover:bg-hover hover:text-ink" onClick={() => shiftMonth(1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      <div className="grid grid-cols-7 text-center">
        {WEEKDAYS.map((d, i) => (
          <span key={i} className="py-0.5 text-[11px] font-medium text-faint">
            {d}
          </span>
        ))}
        {grid.map((d) => {
          const iso = fmtDate(d);
          const inMonth = d.getMonth() === view.month;
          return (
            <button
              key={iso}
              type="button"
              className={cn(
                'rounded py-1 text-[12px] hover:bg-hover',
                inMonth ? 'text-ink' : 'text-faint',
                iso === selected && 'bg-primary text-[var(--text-on-dark)] hover:bg-primary',
                iso === todayStr && iso !== selected && 'font-semibold text-[var(--accent)]',
              )}
              onClick={() => commit(iso)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      <div className="mt-1 flex items-center justify-between border-t border-border-default px-1 pt-1.5">
        <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => commit(null)}>
          Clear
        </button>
        <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => commit(todayStr)}>
          Today
        </button>
      </div>
    </div>
  );
}
