'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { DatePicker } from '@/components/ui/date-picker';
import { Avatar } from '@/components/ui/avatar';
import { RelationChips } from './relation-cell';
import type { LinkChip } from './relation-cell';
import type { Field, SelectOption } from './use-table-data';
import { useDateFormat } from '@/lib/preferences';
import { useConfirm } from '@/components/ui/confirm-dialog';

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
  memberImages?: Map<string, string | null>;
}

/** Plain text of a BlockNote document, for grid previews. */
export function richTextPreview(blocks: unknown, max = 200): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (out.join(' ').length > max) return;
      if (typeof node !== 'object' || node === null) continue;
      const block = node as { content?: unknown; children?: unknown[]; text?: unknown };
      if (typeof block.text === 'string') out.push(block.text);
      if (Array.isArray(block.content)) walk(block.content);
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  if (Array.isArray(blocks)) walk(blocks);
  return out.join(' ').trim().slice(0, max);
}

/** Plain-text rendering of a cell value for the clipboard (MN copy/paste). */
export function cellToText(field: { type: string; options?: SelectOption[] }, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  switch (field.type) {
    case 'rich_text':
      return richTextPreview(value, 100000);
    case 'select':
      return field.options?.find((o) => o.id === value)?.label ?? String(value);
    case 'multi_select': {
      const ids = Array.isArray(value) ? value : [value];
      return ids.map((id) => field.options?.find((o) => o.id === id)?.label ?? String(id)).join(', ');
    }
    case 'checkbox':
      return value === true ? 'true' : 'false';
    case 'relation': {
      const chips = (value as Array<{ title?: string }>) ?? [];
      return chips.map((c) => c.title ?? '').filter(Boolean).join(', ');
    }
    case 'date': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
    }
    default:
      return String(value);
  }
}

export function CellDisplay({ field, value, memberNames, memberImages }: DisplayProps) {
  const fmt = useDateFormat();
  if (value === undefined || value === null || value === '') {
    return <span className="text-faint"> </span>;
  }
  switch (field.type) {
    case 'rich_text': {
      const preview = richTextPreview(value);
      return preview ? (
        <span className="truncate text-[13px] text-ink-secondary">{preview}</span>
      ) : (
        <span className="text-faint"> </span>
      );
    }
    case 'formula': {
      const rt = field.config['result_type'] as string | undefined;
      if (rt === 'checkbox') return <input type="checkbox" checked={value === true} readOnly className="pointer-events-none" />;
      if (rt === 'number') return <span className="w-full truncate text-right text-[13px] tabular-nums">{String(value)}</span>;
      return <span className="truncate text-[13px] text-ink-secondary">{String(value)}</span>;
    }
    case 'rollup': {
      if (value === null || value === undefined) return <span className="text-faint"> </span>;
      const n = value as number;
      const shown = Number.isInteger(n) ? String(n) : n.toFixed(2);
      return <span className="w-full truncate text-right text-[13px] tabular-nums">{shown}</span>;
    }
    case 'lookup': {
      // Server resolves values (select ids → labels); scalar or array by cardinality.
      const items = Array.isArray(value) ? value : [value];
      const text = items
        .map((v) => (v === true ? '✓' : v === false ? '—' : String(v)))
        .join(', ');
      return <span className="truncate text-[13px] text-ink-secondary">{text}</span>;
    }
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
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {ids.map((id) => (
            <span key={id} className="flex min-w-0 items-center gap-1 text-[13px]">
              <Avatar userId={id} name={memberNames.get(id) ?? '?'} image={memberImages?.get(id)} size={16} />
              <span className="truncate">{memberNames.get(id) ?? '(unknown)'}</span>
            </span>
          ))}
        </span>
      );
    }
    case 'date':
    case 'created_at':
    case 'updated_at': {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return <span className="truncate text-[13px]">{String(value)}</span>;
      // System timestamps carry a time; plain date fields show the day only.
      const shown = field.type === 'date' ? fmt.date(d) : fmt.dateTime(d);
      return <span className="truncate text-[13px] tabular-nums text-ink-secondary">{shown}</span>;
    }
    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className="block max-w-full truncate text-[13px] text-info underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value).replace(/^https?:\/\//, '')}
        </a>
      );
    case 'number':
      return <span className="w-full truncate text-right text-[13px] tabular-nums">{String(value)}</span>;
    case 'id':
      // Public per-database sequential id (MN-087) — muted, monospace-ish.
      return <span className="truncate text-[12px] tabular-nums text-faint">{String(value)}</span>;
    case 'title':
      return <span className="truncate text-[13px] font-medium text-ink">{String(value)}</span>;
    default:
      return <span className="truncate text-[13px]">{String(value)}</span>;
  }
}

/** A record as views see it — scalar values keyed by api_name, plus system columns. */
export interface ViewRow {
  number: number | null;
  title: string;
  values: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** created_at/updated_at are date-typed system fields — usable anywhere a date is (MN-150). */
export function isDateField(field: { type: string }): boolean {
  return field.type === 'date' || field.type === 'created_at' || field.type === 'updated_at';
}

/** created_at/updated_at can't be edited (system-managed). */
export function isSystemDate(type: string): boolean {
  return type === 'created_at' || type === 'updated_at';
}

/** Read a field's value, sourcing system columns (id/title/timestamps) from the row. */
export function fieldValue(row: ViewRow, field: { type: string; apiName: string }): unknown {
  switch (field.type) {
    case 'id':
      return row.number;
    case 'title':
      return row.title;
    case 'created_at':
      return row.created_at;
    case 'updated_at':
      return row.updated_at;
    default:
      return row.values[field.apiName];
  }
}

interface EditorProps {
  field: Field;
  value: unknown;
  members: Array<{ id: string; name: string; image?: string | null }>;
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
      return <NumberEditor initial={value == null ? null : Number(value)} onCommit={onCommit} onCancel={onCancel} />;
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
          options={members.map((m) => ({ id: m.id, label: m.name, color: 'gray', image: m.image }))}
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

/** Number editor with arrow-key + on-screen +/- stepping (MN-072). */
function NumberEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: number | null;
  onCommit: (value: number | null) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial === null ? '' : String(initial));
  const committed = useRef(false);
  const commit = (raw: string) => {
    committed.current = true;
    onCommit(raw.trim() === '' ? null : Number(raw));
  };
  const step = (delta: number) => {
    const next = (Number(val) || 0) + delta;
    setVal(String(next));
  };
  return (
    <div className="flex h-full items-center gap-1 bg-card pr-1">
      <input
        autoFocus
        inputMode="decimal"
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] text-ink outline-none"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          if (!committed.current) commit(val);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(val);
          else if (e.key === 'Escape') {
            committed.current = true;
            onCancel();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(-1);
          }
          e.stopPropagation();
        }}
      />
      <div className="flex flex-col">
        <button
          type="button"
          tabIndex={-1}
          className="flex h-3 w-4 items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-ink"
          onMouseDown={(e) => {
            e.preventDefault();
            step(1);
          }}
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          className="flex h-3 w-4 items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-ink"
          onMouseDown={(e) => {
            e.preventDefault();
            step(-1);
          }}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
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
  options: Array<SelectOption & { image?: string | null }>;
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
            {option.image !== undefined ? (
              <span className="flex items-center gap-1.5 text-[13px] text-ink">
                <Avatar userId={option.id} name={option.label} image={option.image} size={16} />
                {option.label}
              </span>
            ) : (
              <OptionChip option={option} />
            )}
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


/** Button field renderer (MN-046): presses run server-side as the caller. */
export function PressButton({
  ws,
  db,
  recordId,
  field,
  disabled,
  onPressed,
}: {
  ws: string;
  db: string;
  recordId: string;
  field: Field;
  disabled?: boolean;
  onPressed?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const color = OPTION_COLORS[(field.config['color'] as string) ?? 'gold'] ?? OPTION_COLORS.gold!;
  const confirmText = field.config['confirm'] as string | undefined;

  async function press(e: React.MouseEvent) {
    e.stopPropagation();
    if (disabled || busy) return;
    if (confirmText && !(await confirm({ title: confirmText, confirmLabel: 'Continue' }))) return;
    setBusy(true);
    const { data, error } = await api.POST(
      '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/buttons/{field}/press' as never,
      { params: { path: { ws, db, rec: recordId, field: field.id } } } as never,
    );
    setBusy(false);
    if (error) {
      toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Button failed');
      return;
    }
    const effects = (data as unknown as { effects: Array<{ summary: string }> }).effects;
    toast.success(`${field.displayName}: ${effects.map((f) => f.summary).join(' · ')}`);
    onPressed?.();
  }

  return (
    <button
      type="button"
      title={disabled ? 'Requires editor access' : undefined}
      className={cn(
        'rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:brightness-95',
      )}
      style={{ backgroundColor: `${color}26`, color }}
      onClick={press}
      disabled={disabled || busy}
    >
      {busy ? '…' : field.displayName}
    </button>
  );
}
