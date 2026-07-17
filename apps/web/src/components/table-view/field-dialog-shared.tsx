'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AtSign,
  Calculator,
  Calendar,
  CheckSquare,
  Hash,
  Link2,
  List,
  MousePointerClick,
  Palette,
  Pilcrow,
  Search,
  Sigma,
  Tags,
  Type,
  UserRound,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { OPTION_COLORS } from './cells';
import type { Field } from './use-table-data';

export const FIELD_TYPES: Array<{
  value: string;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { value: 'text', label: 'Text', description: 'A simple plain string', icon: Type },
  { value: 'rich_text', label: 'Rich text', description: 'Headings, lists, bold, links', icon: Pilcrow },
  { value: 'number', label: 'Number', description: 'Plain, percent or currency', icon: Hash },
  { value: 'select', label: 'Select', description: 'One option from a list', icon: List },
  { value: 'multi_select', label: 'Multi-select', description: 'Any number of options', icon: Tags },
  { value: 'date', label: 'Date', description: 'Date, optionally with time', icon: Calendar },
  { value: 'checkbox', label: 'Checkbox', description: 'Done / not done', icon: CheckSquare },
  { value: 'user', label: 'Person', description: 'Workspace members', icon: UserRound },
  { value: 'url', label: 'URL', description: 'A link', icon: Link2 },
  { value: 'email', label: 'Email', description: 'An email address', icon: AtSign },
  { value: 'color', label: 'Color', description: 'A hex color with a swatch', icon: Palette },
  { value: 'relation', label: 'Relation', description: 'Link records in another database', icon: Workflow },
  { value: 'lookup', label: 'Lookup', description: "Show a related record's field here", icon: Search },
  { value: 'rollup', label: 'Rollup', description: 'Sum / count / average related records', icon: Calculator },
  { value: 'button', label: 'Button', description: 'One click runs actions on the record', icon: MousePointerClick },
  { value: 'formula', label: 'Formula', description: 'Computed from other fields', icon: Sigma },
];

/** Conversions the API allows (docs/architecture/record-storage.md). */
export const CONVERTIBLE: Record<string, string[]> = {
  text: ['number', 'date', 'rich_text'],
  rich_text: ['text'],
  number: ['text'],
  checkbox: ['text'],
  date: ['text'],
  select: ['text', 'multi_select'],
  multi_select: ['text', 'select'],
  url: ['text', 'email'],
  email: ['text', 'url'],
  user: [],
};

export const COLOR_NAMES = Object.keys(OPTION_COLORS);

/** First palette color not in use yet, so new options don't all land on gray. */
export function nextColor(used: string[]): string {
  return COLOR_NAMES.find((c) => c !== 'gray' && !used.includes(c)) ?? COLOR_NAMES[used.length % COLOR_NAMES.length]!;
}

export function useFieldMutations(ws: string, db: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['database', ws, db] });
    void qc.invalidateQueries({ queryKey: ['records', ws, db] });
  };
  return { invalidate, ws, db, qc };
}

export interface OptionDraft {
  key: number;
  label: string;
  color: string;
}

/* ---------- shared building blocks ---------- */

export function TypePicker({ value, onChange }: { value: string; onChange: (type: string) => void }) {
  return (
    // 3 columns so the whole catalogue fits without pushing the type config below the
    // fold (#86); falls back to 2 on narrow viewports.
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {FIELD_TYPES.map((t) => (
        <button
          key={t.value}
          type="button"
          className={cn(
            'flex items-start gap-2 rounded-[var(--radius-card)] border p-2 text-left',
            value === t.value
              ? 'border-[var(--accent)] bg-accent-soft'
              : 'border-border-default hover:bg-hover',
          )}
          onClick={() => onChange(t.value)}
        >
          <t.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">{t.label}</span>
            <span className="block truncate text-[11px] text-muted">{t.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ColorDot({ color, onPick }: { color: string; onPick: (color: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={color}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-border-default hover:bg-hover"
        >
          <span
            className="h-3.5 w-3.5 rounded-full"
            style={{ backgroundColor: OPTION_COLORS[color] ?? OPTION_COLORS.gray }}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="grid w-44 grid-cols-5 gap-1 p-2">
        {COLOR_NAMES.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded hover:bg-hover',
              c === color && 'ring-1 ring-[var(--accent)]',
            )}
            onClick={() => onPick(c)}
          >
            <span className="h-4 w-4 rounded-full" style={{ backgroundColor: OPTION_COLORS[c] }} />
          </button>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Per-type settings, shared between create and edit. */
export function ConfigEditor({
  type,
  config,
  onChange,
}: {
  type: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const set = (key: string, value: unknown) => onChange({ ...config, [key]: value });

  if (type === 'text') {
    return (
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={Boolean(config.multiline)}
          onChange={(e) => set('multiline', e.target.checked)}
        />
        Multi-line
      </label>
    );
  }
  if (type === 'date') {
    return (
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={Boolean(config.include_time)}
          onChange={(e) => set('include_time', e.target.checked)}
        />
        Include time
      </label>
    );
  }
  if (type === 'user') {
    return (
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={Boolean(config.multi)}
          onChange={(e) => set('multi', e.target.checked)}
        />
        Allow multiple people
      </label>
    );
  }
  if (type === 'number') {
    const format = (config.format as string) ?? 'plain';
    const precision = config.precision;
    return (
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Format</Label>
          <select
            className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
            value={format}
            onChange={(e) => set('format', e.target.value)}
          >
            <option value="plain">Plain</option>
            <option value="percent">Percent</option>
            <option value="currency">Currency</option>
          </select>
        </div>
        {format === 'currency' && (
          <div className="flex flex-col gap-1.5">
            <Label>Currency</Label>
            <Input
              className="w-20 uppercase"
              placeholder="USD"
              maxLength={3}
              value={(config.currency_code as string) ?? ''}
              onChange={(e) => set('currency_code', e.target.value.toUpperCase() || undefined)}
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label>Decimals</Label>
          <select
            className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
            value={precision === undefined ? 'auto' : String(precision)}
            onChange={(e) =>
              set('precision', e.target.value === 'auto' ? undefined : Number(e.target.value))
            }
          >
            <option value="auto">Auto</option>
            {[0, 1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }
  return null;
}

export function useDeleteField({
  ws,
  db,
  field,
  onDone,
}: {
  ws: string;
  db: string;
  field: Field;
  onDone: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const confirm = useConfirm();

  const del = useMutation({
    mutationFn: async () => {
      // A relation is a paired field on two databases — deleting it goes through the
      // relations API, which drops BOTH fields + every link (the field-delete API
      // refuses relations). Warn about the blast radius before doing it.
      if (field.type === 'relation' && field.relation) {
        const other = field.relation.target_database_name ?? 'the other database';
        if (
          !(await confirm({
            title: `Delete the "${field.displayName}" relation?`,
            message: `This removes the relation, BOTH paired fields (this one and its inverse on ${other}), and every link between records. This can't be undone.`,
            confirmLabel: 'Delete relation',
            danger: true,
          }))
        ) {
          return false;
        }
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/relations/{rel}', {
          params: { path: { ws, rel: field.relation.id } },
          body: { confirm: true } as never,
        });
        if (error) throw error;
        return true;
      }

      const usage = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/usage',
        { params: { path: { ws, db, field: field.id } } },
      );
      const count = (usage.data as { records_with_value: number } | undefined)?.records_with_value ?? 0;
      if (
        !(await confirm({
          title: `Delete "${field.displayName}"?`,
          message:
            count > 0
              ? `This field has values on ${count} record(s). They'll be lost. Delete anyway?`
              : undefined,
          confirmLabel: 'Delete',
          danger: true,
        }))
      ) {
        return false;
      }
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: field.id } },
      });
      if (error) throw error;
      return true;
    },
    onSuccess: (deleted) => {
      if (deleted) {
        invalidate();
        toast.success(field.type === 'relation' ? 'Relation deleted' : 'Field deleted');
      }
      onDone();
    },
    onError: (err: unknown) => {
      // Surface the server's reason (e.g. "needs creator on both databases") when present.
      const message =
        err && typeof err === 'object' && 'error' in err
          ? (err as { error?: { message?: string } }).error?.message
          : undefined;
      toast.error(message ?? 'This field cannot be deleted');
      onDone();
    },
  });

  return del;
}
