'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { DatePicker } from '@/components/ui/date-picker';
import { RelationChips } from './relation-cell';
import type { LinkChip } from './relation-cell';
import type { Field, SelectOption } from './use-table-data';

/** Warm-tuned chip colors (docs/design/design-system.md). */
export const OPTION_COLORS: Record<string, string> = {
  gray: '#B5B0A5',
  brown: '#8B6F47',
  gold: '#D4A017',
  orange: '#D97E36',
  red: '#C0392B',
  pink: '#C05B7E',
  purple: '#7E5BA6',
  blue: '#3D5296',
  teal: '#057160',
  green: '#2D7A4F',
};

export function OptionChip({ option }: { option: SelectOption }) {
  const color = OPTION_COLORS[option.color] ?? OPTION_COLORS.gray!;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[12px] font-medium"
      style={{ backgroundColor: `${color}1F`, color }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{option.label}</span>
    </span>
  );
}

interface DisplayProps {
  field: Field;
  value: unknown;
  memberNames: Map<string, string>;
}

export function CellDisplay({ field, value, memberNames }: DisplayProps) {
  if (value === undefined || value === null || value === '') {
    return <span className="text-faint"> </span>;
  }
  switch (field.type) {
    case 'relation':
      return <RelationChips chips={(value as LinkChip[]) ?? []} />;
    case 'checkbox':
      return <input type="checkbox" checked={Boolean(value)} readOnly className="pointer-events-none" />;
    case 'select': {
      const option = field.options?.find((o) => o.id === value);
      return option ? <OptionChip option={option} /> : null;
    }
    case 'multi_select': {
      const ids = value as string[];
      return (
        <span className="flex gap-1 overflow-hidden">
          {ids
            .map((id) => field.options?.find((o) => o.id === id))
            .filter((o): o is SelectOption => Boolean(o))
            .map((o) => (
              <OptionChip key={o.id} option={o} />
            ))}
        </span>
      );
    }
    case 'user': {
      const ids = Array.isArray(value) ? (value as string[]) : [String(value)];
      return (
        <span className="truncate text-[13px]">
          {ids.map((id) => memberNames.get(id) ?? '(unknown)').join(', ')}
        </span>
      );
    }
    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className="truncate text-[13px] text-info underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value).replace(/^https?:\/\//, '')}
        </a>
      );
    case 'number':
      return <span className="w-full truncate text-right text-[13px] tabular-nums">{String(value)}</span>;
    case 'title':
      return <span className="truncate text-[13px] font-medium text-ink">{String(value)}</span>;
    default:
      return <span className="truncate text-[13px]">{String(value)}</span>;
  }
}

interface EditorProps {
  field: Field;
  value: unknown;
  members: Array<{ id: string; name: string }>;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}

/** Inline editor per field type. Enter commits, Esc cancels, blur commits. */
export function CellEditor({ field, value, members, onCommit, onCancel }: EditorProps) {
  switch (field.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
      return <TextEditor initial={value == null ? '' : String(value)} onCommit={(v) => onCommit(v === '' ? null : v)} onCancel={onCancel} />;
    case 'number':
      return (
        <TextEditor
          initial={value == null ? '' : String(value)}
          inputMode="decimal"
          onCommit={(v) => onCommit(v === '' ? null : Number(v))}
          onCancel={onCancel}
        />
      );
    case 'date': {
      const includeTime = field.config['include_time'] === true;
      return (
        <DatePicker
          value={value == null ? null : String(value)}
          includeTime={includeTime}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
    }
    case 'select':
      return (
        <OptionList
          options={field.options ?? []}
          selected={value == null ? [] : [String(value)]}
          onPick={(id) => onCommit(id)}
          onClear={() => onCommit(null)}
          onClose={onCancel}
        />
      );
    case 'multi_select':
      return (
        <OptionList
          multi
          options={field.options ?? []}
          selected={Array.isArray(value) ? (value as string[]) : []}
          onToggle={(ids) => onCommit(ids.length ? ids : null)}
          onClear={() => onCommit(null)}
          onClose={onCancel}
        />
      );
    case 'user': {
      const multi = field.config['multi'] === true;
      const selected = value == null ? [] : Array.isArray(value) ? (value as string[]) : [String(value)];
      return (
        <OptionList
          multi={multi}
          options={members.map((m) => ({ id: m.id, label: m.name, color: 'gray' }))}
          selected={selected}
          onPick={(id) => onCommit(id)}
          onToggle={(ids) => onCommit(ids.length ? ids : null)}
          onClear={() => onCommit(null)}
          onClose={onCancel}
        />
      );
    }
    default:
      return null;
  }
}

function TextEditor({
  initial,
  inputMode,
  onCommit,
  onCancel,
}: {
  initial: string;
  inputMode?: 'decimal';
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  const committed = useRef(false);
  return (
    <input
      autoFocus
      inputMode={inputMode}
      className="h-full w-full bg-card px-2 text-[13px] text-ink outline-none"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (!committed.current) onCommit(val.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          committed.current = true;
          onCommit(val.trim());
        }
        if (e.key === 'Escape') {
          committed.current = true;
          onCancel();
        }
        e.stopPropagation();
      }}
    />
  );
}

function OptionList({
  options,
  selected,
  multi = false,
  onPick,
  onToggle,
  onClear,
  onClose,
}: {
  options: SelectOption[];
  selected: string[];
  multi?: boolean;
  onPick?: (id: string) => void;
  onToggle?: (ids: string[]) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string[]>(selected);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (multi) onToggle?.(current);
        else onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [multi, current, onToggle, onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-0.5 max-h-64 w-56 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card p-1 shadow-[0_4px_12px_rgba(15,23,41,0.08)]"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {options.map((option) => {
        const isSelected = current.includes(option.id);
        return (
          <button
            key={option.id}
            className={cn(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover',
              isSelected && 'bg-hover',
            )}
            onClick={() => {
              if (multi) {
                setCurrent((prev) =>
                  prev.includes(option.id) ? prev.filter((x) => x !== option.id) : [...prev, option.id],
                );
              } else {
                onPick?.(option.id);
              }
            }}
          >
            {multi && <input type="checkbox" readOnly checked={isSelected} />}
            <OptionChip option={option} />
          </button>
        );
      })}
      <div className="mt-1 flex justify-between border-t border-border-default px-2 pt-1">
        <button className="text-[12px] text-muted hover:text-ink" onClick={onClear}>
          Clear
        </button>
        {multi && (
          <button className="text-[12px] text-ink underline" onClick={() => onToggle?.(current)}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
