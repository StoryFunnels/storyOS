'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AtSign,
  Calculator,
  Calendar,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CircleDot,
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
import { EntityIcon, IconColorPicker } from '@/components/ui/icon-picker';
import { FormulaEditor } from './formula-editor';
import type { Field } from './use-table-data';

export const FIELD_TYPES: Array<{
  value: string;
  label: string;
  /**
   * #321 — the phrase shown FIRST in the type picker, for types whose real name
   * is database jargon. Present only where it earns its place; see the note on
   * lookup/rollup below.
   */
  plainLabel?: string;
  description: string;
  icon: LucideIcon;
}> = [
  { value: 'text', label: 'Text', description: 'A simple plain string', icon: Type },
  { value: 'rich_text', label: 'Rich text', description: 'Headings, lists, bold, links', icon: Pilcrow },
  { value: 'number', label: 'Number', description: 'Plain, percent or currency', icon: Hash },
  { value: 'select', label: 'Single Select', description: 'One option from a list', icon: List },
  { value: 'multi_select', label: 'Multi-select', description: 'Any number of options', icon: Tags },
  // #172: the canonical status field — a database can have at most one.
  { value: 'workflow', label: 'Workflow / Status', description: 'The single status of each item', icon: CircleDot },
  { value: 'date', label: 'Date', description: 'Date, optionally with time', icon: Calendar },
  { value: 'checkbox', label: 'Checkbox', description: 'Done / not done', icon: CheckSquare },
  { value: 'user', label: 'Person', description: 'Workspace members', icon: UserRound },
  { value: 'url', label: 'URL', description: 'A link', icon: Link2 },
  { value: 'email', label: 'Email', description: 'An email address', icon: AtSign },
  { value: 'color', label: 'Color', description: 'A hex color with a swatch', icon: Palette },
  { value: 'relation', label: 'Relation', description: 'Link to another list', icon: Workflow },
  /*
   * #321 — `plainLabel` leads in the PICKER and demotes the jargon to a sub-note.
   *
   * Only these two carry it. "Text", "Date", "Relation", "Formula" are already
   * ordinary English a first-time user can parse; "lookup" and "rollup" are
   * database vocabulary that means nothing until someone teaches it to you.
   *
   * `label` deliberately stays the short noun, because it is ALSO used inline in
   * prose (change-type-dialog: "Rollup fields cannot be converted") — lengthening
   * it there would produce nonsense. Keeping the jargon visible as the sub-note
   * is not a compromise either: it is the word people migrating from other tools
   * search for.
   */
  {
    value: 'lookup',
    label: 'Lookup',
    plainLabel: 'Show info from a linked item',
    description: 'Show info from a linked item',
    icon: Search,
  },
  {
    value: 'rollup',
    label: 'Rollup',
    plainLabel: 'Count or total linked items',
    description: 'Count or total linked items',
    icon: Calculator,
  },
  { value: 'button', label: 'Button', description: 'One click runs actions on the item', icon: MousePointerClick },
  { value: 'formula', label: 'Formula', description: 'Auto-calculated value', icon: Sigma },
];

/** #150: Basic types shown first; everything else lives under "Advanced". */
export const BASIC_FIELD_TYPES = new Set([
  'text',
  'number',
  'date',
  'select',
  'workflow',
  'checkbox',
  'user',
  'url',
  'email',
]);

/** Conversions the API allows (docs/architecture/record-storage.md). */
export const CONVERTIBLE: Record<string, string[]> = {
  text: ['number', 'date', 'rich_text'],
  rich_text: ['text'],
  number: ['text'],
  checkbox: ['text'],
  date: ['text'],
  select: ['text', 'multi_select', 'workflow'],
  multi_select: ['text', 'select', 'workflow'],
  workflow: ['text', 'select', 'multi_select'],
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
  /** #202 — optional curated icon ref (`set:<name>` / `brand:<slug>`). */
  icon?: string | null;
}

/* ---------- shared building blocks ---------- */

function TypeButtonGrid({
  types,
  value,
  onChange,
  disabledTypes,
}: {
  types: typeof FIELD_TYPES;
  value: string;
  onChange: (type: string) => void;
  /** #172: value → reason. A disabled type can't be picked; the reason is its tooltip. */
  disabledTypes?: Record<string, string>;
}) {
  return (
    // 3 columns so the whole catalogue fits without pushing the type config below the
    // fold (#86); falls back to 2 on narrow viewports.
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {types.map((t) => {
        const disabledReason = disabledTypes?.[t.value];
        return (
          <button
            key={t.value}
            type="button"
            disabled={Boolean(disabledReason)}
            title={disabledReason}
            className={cn(
              'flex items-start gap-2 rounded-[var(--radius-card)] border p-2 text-left',
              value === t.value
                ? 'border-[var(--accent)] bg-accent-soft'
                : 'border-border-default hover:bg-hover',
              disabledReason && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
            onClick={() => !disabledReason && onChange(t.value)}
          >
            <t.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0">
              {/* #321: a type with a plainLabel leads with the plain phrase and
                  shows its real name underneath, so the jargon stays findable
                  without being the first thing a newcomer has to decode. */}
              <span className="block text-[13px] font-medium text-ink">
                {t.plainLabel ?? t.label}
              </span>
              <span className="block truncate text-[11px] text-muted">
                {disabledReason ?? (t.plainLabel ? t.label : t.description)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function TypePicker({
  value,
  onChange,
  disabledTypes,
}: {
  value: string;
  onChange: (type: string) => void;
  disabledTypes?: Record<string, string>;
}) {
  // #150: lead with the everyday types; tuck the power types (Relation, Lookup,
  // Rollup, Formula, Button, Color, Rich text, Multi-select) under a collapsed
  // "Advanced" heading so non-technical users aren't faced with all 16 at once.
  const basic = FIELD_TYPES.filter((t) => BASIC_FIELD_TYPES.has(t.value));
  const advanced = FIELD_TYPES.filter((t) => !BASIC_FIELD_TYPES.has(t.value));
  // Start expanded when the current type is itself an advanced one (e.g. the
  // dialog was opened preset to lookup via MN-17) so the selection is visible.
  const [showAdvanced, setShowAdvanced] = useState(() =>
    advanced.some((t) => t.value === value),
  );

  return (
    <div className="flex flex-col gap-2">
      <TypeButtonGrid types={basic} value={value} onChange={onChange} disabledTypes={disabledTypes} />
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-[12px] font-medium text-muted hover:text-ink"
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((s) => !s)}
      >
        {showAdvanced ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Advanced
      </button>
      {showAdvanced && (
        <TypeButtonGrid types={advanced} value={value} onChange={onChange} disabledTypes={disabledTypes} />
      )}
    </div>
  );
}

/**
 * #202/#213 — an option's appearance: icon AND colour, in one control.
 *
 * Reuses `IconColorPicker`, the same picker a database icon uses, rather than adding
 * a second parallel icon UI — the storage (`select_options.icon`) and the rendering
 * (`OptionChip` → `OptionIcon`) already shipped; only this was missing, so an icon
 * could be stored and drawn but never SET. See docs/architecture/field-surfaces.md.
 */
export function OptionAppearance({
  icon,
  color,
  onChange,
}: {
  icon?: string | null;
  color: string;
  onChange: (patch: { icon?: string | null; color?: string | null }) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Icon & colour"
          aria-label="Icon and colour"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-border-default hover:bg-hover"
        >
          <EntityIcon
            icon={icon ?? null}
            color={color}
            size={14}
            fallback={
              <span
                className="h-3.5 w-3.5 rounded-full"
                style={{ backgroundColor: OPTION_COLORS[color] ?? OPTION_COLORS.gray }}
              />
            }
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto p-2">
        <IconColorPicker icon={icon ?? null} color={color} onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
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
  ws,
  db,
  fields,
}: {
  type: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  /** Provided only where the title field is edited (MN-131) — the computed-name
   * editor reuses the formula editor, which needs the workspace/database + the
   * database's fields to resolve `{Field}` references and preview. */
  ws?: string;
  db?: string;
  fields?: Field[];
}) {
  const set = (key: string, value: unknown) => onChange({ ...config, [key]: value });

  // MN-131: the title field's "name" can be free text (classic) or computed from
  // a template. The computed branch reuses the SAME formula editor formula fields
  // use; on save we persist only { name_mode, source } — the server compiles the
  // ast/result_type (fields.service#compileTitleConfig), same as #130's contract.
  if (type === 'title' && ws && db) {
    return <TitleNameConfig ws={ws} db={db} fields={fields ?? []} config={config} onChange={onChange} />;
  }

  // A formula field had NO editor here, so "Edit field" on one offered only a
  // rename: the expression could be written once and never corrected — you had to
  // delete the field (losing it from every view) and start again. Same editor the
  // create dialog uses; the server recompiles `ast`/`result_type` from
  // `expression` on save (fields.service.update), so only the expression and the
  // #190 percent flag are sent.
  if (type === 'formula' && ws && db) {
    const expression = typeof config.expression === 'string' ? config.expression : '';
    // No <Label> here — FormulaEditor renders its own, and a second one stacked
    // "Formula / Formula" above the box.
    return (
      <div className="flex flex-col gap-1.5">
        <FormulaEditor
          ws={ws}
          db={db}
          fields={(fields ?? []).filter((f) => f.type !== 'formula' || f.config?.expression !== expression)}
          expression={expression}
          onChange={(next) => onChange({ ...config, expression: next })}
          format={config.format === 'percent' ? 'percent' : 'plain'}
          onFormatChange={(next) =>
            onChange(next === 'percent' ? { ...config, format: 'percent' } : { ...config, format: undefined })
          }
        />
      </div>
    );
  }

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
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={Boolean(config.include_time)}
            onChange={(e) => set('include_time', e.target.checked)}
          />
          Include time
        </label>
        {/*
         * #203 — a flag, not a date input. A literal default date is correct for
         * about a day and silently wrong after that; "today" is the only date
         * default that stays true, and it resolves server-side at insert.
         */}
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={Boolean(config.default_today)}
            onChange={(e) => set('default_today', e.target.checked)}
          />
          Default new records to today
        </label>
      </div>
    );
  }
  if (type === 'checkbox') {
    // #203 — two states, so a literal default is the whole story here.
    return (
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={Boolean(config.default)}
          onChange={(e) => set('default', e.target.checked)}
        />
        Checked by default on new records
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
  if (type === 'formula') {
    // #190: expression editing after creation isn't offered here, but a number
    // formula can be toggled to percent so it renders as a progress bar. The
    // server stores result_type after compiling, so gate on it; if it's not a
    // number, there's nothing to format.
    if (config.result_type !== 'number') return null;
    return (
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={config.format === 'percent'}
          onChange={(e) => set('format', e.target.checked ? 'percent' : 'plain')}
        />
        Show as percentage (progress bar)
      </label>
    );
  }
  return null;
}

/**
 * MN-131: the title field's name-mode editor. A "Free text ⇆ Computed" toggle;
 * in Computed mode it embeds the shared {@link FormulaEditor} (same editor +
 * autocomplete + live preview formula fields use) and stores the raw template in
 * `source`. Read-only mode itself is enforced by #130's backend and reflected in
 * the record UI (record page title + inline title cell go read-only). Only the
 * template `source` and `name_mode` are persisted here — the server compiles the
 * ast/result_type on save. Own-record references only in v1 (#132 for the rest).
 */
function TitleNameConfig({
  ws,
  db,
  fields,
  config,
  onChange,
}: {
  ws: string;
  db: string;
  fields: Field[];
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const mode = config.name_mode === 'computed' ? 'computed' : 'freetext';
  const source = typeof config.source === 'string' ? config.source : '';
  // Exclude the title field itself — a `{Name}` self-reference is a cycle the
  // server rejects, so don't offer it as a referenceable field.
  const refFields = fields.filter((f) => f.type !== 'title');

  return (
    <div className="flex flex-col gap-2">
      <Label>Name</Label>
      <div className="inline-flex w-fit rounded-[var(--radius-control)] border border-border-default p-0.5">
        {(
          [
            ['freetext', 'Free text'],
            ['computed', 'Computed'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={cn(
              'rounded px-2.5 py-1 text-[12px]',
              mode === value ? 'bg-active font-medium text-ink' : 'text-muted hover:text-ink',
            )}
            onClick={() =>
              onChange(value === 'computed' ? { name_mode: 'computed', source } : { name_mode: 'freetext' })
            }
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'freetext' ? (
        <p className="text-[12px] text-faint">
          Each record’s name is typed in by hand — the classic editable title.
        </p>
      ) : (
        <>
          <FormulaEditor
            ws={ws}
            db={db}
            fields={refFields}
            expression={source}
            onChange={(next) => onChange({ name_mode: 'computed', source: next })}
          />
          <p className="text-[12px] text-faint">
            The name is generated from this template on every save and can’t be edited
            directly. Records fall back to <code className="text-muted">#id</code> when the
            template is empty. References this record’s own fields only.
          </p>
        </>
      )}
    </div>
  );
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
