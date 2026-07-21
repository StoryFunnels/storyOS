'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { DatePicker } from '@/components/ui/date-picker';
import { Avatar } from '@/components/ui/avatar';
import { Popover, PopoverContent, PopoverParentAnchor } from '@/components/ui/popover';
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

/** First palette color not already in use, so inline-created options don't
 * all land on gray (mirrors `nextColor` in field-dialog-shared.tsx — kept as
 * a small local copy to avoid a cells.tsx <-> field-dialog-shared.tsx import
 * cycle, since that module already imports OPTION_COLORS from here). */
function nextOptionColor(used: string[]): string {
  const names = Object.keys(OPTION_COLORS);
  return names.find((c) => c !== 'gray' && !used.includes(c)) ?? names[used.length % names.length]!;
}

/** Color cell editor (#89): a native swatch picker + a hex input, with the brand
 * palette as presets. Commits a normalized #rrggbb; empty clears the value. */
function ColorEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}) {
  const [hex, setHex] = useState(initial);
  const valid = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.trim());
  const commit = () => {
    const v = hex.trim();
    if (v === '') return onCommit(null);
    if (valid) return onCommit(v.toLowerCase());
    onCancel();
  };
  return (
    <Popover open onOpenChange={(open) => !open && onCancel()}>
      <PopoverParentAnchor />
      <PopoverContent
        className="flex w-56 flex-col gap-2 p-2 shadow-[0_8px_24px_rgba(15,23,41,0.15)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={valid ? hex : '#000000'}
            onChange={(e) => setHex(e.target.value)}
            className="h-7 w-8 cursor-pointer rounded border border-border-default bg-card p-0.5"
          />
          <input
            autoFocus
            value={hex}
            placeholder="#4EA7FC"
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') onCancel();
            }}
            className="h-7 min-w-0 flex-1 rounded border border-border-default bg-card px-1.5 text-[13px] tabular-nums text-ink outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(OPTION_COLORS).map(([name, value]) => (
            <button
              key={name}
              title={name}
              onClick={() => onCommit(value.toLowerCase())}
              className="h-4 w-4 rounded-[3px] border border-border-default"
              style={{ backgroundColor: value }}
            />
          ))}
        </div>
        <div className="flex justify-end gap-1.5 text-[12px]">
          <button className="rounded px-1.5 py-0.5 text-muted hover:bg-hover" onClick={() => onCommit(null)}>
            Clear
          </button>
          <button
            className="rounded px-1.5 py-0.5 text-ink hover:bg-hover disabled:opacity-40"
            disabled={hex.trim() !== '' && !valid}
            onClick={commit}
          >
            Save
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Hex color for a record's value on a select field (via its option color), or null.
 * Shared color-by helper for feed/list/timeline views (MN-102). */
export function optionColor(
  field: { type: string; options?: SelectOption[] } | undefined,
  value: unknown,
): string | null {
  if (!field || field.type !== 'select') return null;
  const opt = field.options?.find((o) => o.id === value);
  return opt ? OPTION_COLORS[opt.color] ?? OPTION_COLORS.gray! : null;
}

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
  /**
   * MN-132: the properties sidebar wants prose to WRAP, not clip — a single-line
   * `truncate` is right for a fixed-height grid row but unreadable in the sidebar.
   * When set, text-carrying types wrap and break instead of truncating.
   */
  wrap?: boolean;
}

// Pure text helpers moved to cell-text.ts so they're testable without React
// (MN-135). Imported for CellDisplay's own use, and re-exported so existing
// importers don't churn.
import { cellToText, richTextPreview } from './cell-text';
export { cellToText, richTextPreview };

export function CellDisplay({ field, value, memberNames, memberImages, wrap }: DisplayProps) {
  const fmt = useDateFormat();
  // The prose class: wrap+break in the sidebar (MN-132), truncate in a grid row.
  const prose = wrap ? 'whitespace-pre-wrap break-words' : 'truncate';
  if (value === undefined || value === null || value === '') {
    return <span className="text-faint"> </span>;
  }
  switch (field.type) {
    case 'rich_text': {
      const preview = richTextPreview(value);
      return preview ? (
        <span className={cn('text-[13px] text-ink-secondary', prose)}>{preview}</span>
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
    // 'user' and 'created_by' are both people, resolved the same way (MN-126).
    case 'user':
    case 'created_by': {
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
    case 'color':
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] tabular-nums text-ink-secondary">
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-[3px] border border-border-default"
            style={{ backgroundColor: String(value) }}
          />
          <span className="truncate">{String(value)}</span>
        </span>
      );
    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className={cn('block max-w-full text-[13px] text-info underline', wrap ? 'break-all' : 'truncate')}
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
      return <span className={cn('text-[13px] font-medium text-ink', prose)}>{String(value)}</span>;
    case 'email':
      return <span className={cn('text-[13px]', wrap ? 'break-all' : 'truncate')}>{String(value)}</span>;
    default:
      // text and anything else prose-like.
      return <span className={cn('text-[13px]', prose)}>{String(value)}</span>;
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
  ws: string;
  db: string;
  field: Field;
  value: unknown;
  members: Array<{ id: string; name: string; image?: string | null }>;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}

/** Inline editor per field type. Enter commits, Esc cancels, blur commits. */
export function CellEditor({ ws, db, field, value, members, onCommit, onCancel }: EditorProps) {
  switch (field.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
      return <TextEditor initial={value == null ? '' : String(value)} onCommit={(v) => onCommit(v === '' ? null : v)} onCancel={onCancel} />;
    case 'number':
      return <NumberEditor initial={value == null ? null : Number(value)} onCommit={onCommit} onCancel={onCancel} />;
    case 'color':
      return <ColorEditor initial={value == null ? '' : String(value)} onCommit={onCommit} onCancel={onCancel} />;
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
          ws={ws}
          db={db}
          field={field}
          allowCreate
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
          ws={ws}
          db={db}
          field={field}
          allowCreate
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

/**
 * Select/multi_select/user cell picker (MN-285): type-to-filter over the
 * option list, plus — for select and multi_select only, via `allowCreate` —
 * an inline "+ Add new '<text>'" row that creates the option (POST
 * .../fields/{field}/options) and applies it without leaving the cell
 * editor. Arrow keys move a highlighted row across the filtered list + the
 * create row; Enter picks whatever's highlighted; Escape closes via Radix's
 * built-in dismiss (same as before — no local handling needed).
 */
function OptionList({
  ws,
  db,
  field,
  options,
  selected,
  multi = false,
  allowCreate = false,
  onPick,
  onToggle,
  onClear,
  onClose,
}: {
  ws?: string;
  db?: string;
  field?: Field;
  options: Array<SelectOption & { image?: string | null }>;
  selected: string[];
  multi?: boolean;
  allowCreate?: boolean;
  onPick?: (id: string) => void;
  onToggle?: (ids: string[]) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<string[]>(selected);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const trimmed = query.trim();
  const filtered = useMemo(
    () =>
      trimmed
        ? options.filter((o) => o.label.toLowerCase().includes(trimmed.toLowerCase()))
        : options,
    [options, trimmed],
  );
  const exactMatch = options.some((o) => o.label.toLowerCase() === trimmed.toLowerCase());
  const showCreate = allowCreate && trimmed !== '' && !exactMatch;
  const itemCount = filtered.length + (showCreate ? 1 : 0);

  // MN-230d: closing (outside click, Escape) mirrors the old mousedown-outside
  // handler — multi-select commits whatever is currently checked; single-select
  // just closes (picking an option already commits directly).
  function handleOpenChange(open: boolean) {
    if (open) return;
    if (multi) onToggle?.(current);
    else onClose();
  }

  const addOption = useMutation({
    mutationFn: async (label: string) => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options',
        {
          params: { path: { ws: ws!, db: db!, field: field!.id } },
          body: { label, color: nextOptionColor(options.map((o) => o.color)) } as never,
        },
      );
      if (error) throw error;
      // The endpoint returns the inserted option row ({id, label, color, ...});
      // the generated SDK types the 201 body as untyped, so cast it (matches
      // the relation picker's createTarget cast below).
      return data as unknown as { id: string; label: string; color: string };
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['database', ws, db] });
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
      setQuery('');
      setActive(0);
      if (multi) {
        setCurrent((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
      } else {
        onPick?.(created.id);
      }
    },
    onError: () => toast.error('Could not add the option'),
  });

  function pickIndex(idx: number) {
    if (idx < filtered.length) {
      const option = filtered[idx]!;
      if (multi) {
        setCurrent((prev) =>
          prev.includes(option.id) ? prev.filter((x) => x !== option.id) : [...prev, option.id],
        );
      } else {
        onPick?.(option.id);
      }
    } else if (showCreate && trimmed) {
      addOption.mutate(trimmed);
    }
  }

  return (
    <Popover open onOpenChange={handleOpenChange}>
      <PopoverParentAnchor />
      <PopoverContent
        className="flex max-h-80 w-56 flex-col gap-1 p-1"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder="Search…"
          className="w-full rounded border border-border-default bg-card px-2 py-1 text-[13px] text-ink outline-none placeholder:text-faint"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(itemCount - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (itemCount > 0) pickIndex(active);
            }
            e.stopPropagation();
          }}
        />
        <div className="max-h-60 overflow-y-auto">
          {filtered.map((option, idx) => {
            const isSelected = current.includes(option.id);
            return (
              <button
                key={option.id}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover',
                  (isSelected || idx === active) && 'bg-hover',
                )}
                onMouseEnter={() => setActive(idx)}
                onClick={() => pickIndex(idx)}
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
          {filtered.length === 0 && !showCreate && (
            <p className="px-2 py-1.5 text-[12px] text-faint">No matches</p>
          )}
          {showCreate && (
            <button
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[13px] text-info hover:bg-hover',
                active === filtered.length && 'bg-hover',
              )}
              onMouseEnter={() => setActive(filtered.length)}
              onClick={() => pickIndex(filtered.length)}
              disabled={addOption.isPending}
            >
              <Plus className="h-3.5 w-3.5" />
              {addOption.isPending ? 'Adding…' : `Add new “${trimmed}”`}
            </button>
          )}
        </div>
        <div className="flex justify-between border-t border-border-default px-2 pt-1">
          <button className="text-[12px] text-muted hover:text-ink" onClick={onClear}>
            Clear
          </button>
          {multi && (
            <button className="text-[12px] text-ink underline" onClick={() => onToggle?.(current)}>
              Done
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
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
