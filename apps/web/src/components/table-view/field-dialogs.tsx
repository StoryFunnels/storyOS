'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AtSign,
  Calculator,
  Calendar,
  CheckSquare,
  GripVertical,
  Hash,
  Link2,
  List,
  MousePointerClick,
  Palette,
  Pilcrow,
  Plus,
  Search,
  Sigma,
  Tags,
  Trash2,
  Type,
  UserRound,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { FORMULA_FUNCTIONS, evaluateFormula, parseFormula, typecheck } from '@storyos/schemas';
import { useDatabases, useSpaces } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
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
import { useDatabase } from './use-table-data';
import type { Field } from './use-table-data';

const FIELD_TYPES: Array<{
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
const CONVERTIBLE: Record<string, string[]> = {
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

const COLOR_NAMES = Object.keys(OPTION_COLORS);

/** First palette color not in use yet, so new options don't all land on gray. */
function nextColor(used: string[]): string {
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

interface OptionDraft {
  key: number;
  label: string;
  color: string;
}

/* ---------- shared building blocks ---------- */

function TypePicker({ value, onChange }: { value: string; onChange: (type: string) => void }) {
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

function ColorDot({ color, onPick }: { color: string; onPick: (color: string) => void }) {
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
function ConfigEditor({
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

/* ---------- create ---------- */

let draftKey = 0;

export function AddFieldDialog({
  ws,
  db,
  onDone,
  initialType,
  initialRelationId,
}: {
  ws: string;
  db: string;
  onDone: () => void;
  /** Preset the dialog — e.g. "Add a field from linked records" opens it on lookup + the relation (MN-17). */
  initialType?: string;
  initialRelationId?: string;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const [name, setName] = useState('');
  const [type, setType] = useState<string>(initialType ?? 'text');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [targetDb, setTargetDb] = useState('');
  const [singleTarget, setSingleTarget] = useState(true);
  const [inverseName, setInverseName] = useState('');
  const [lookupRelationId, setLookupRelationId] = useState(initialRelationId ?? '');
  const [lookupTargetApi, setLookupTargetApi] = useState('');
  const [rollupOp, setRollupOp] = useState('count');
  const [buttonActions, setButtonActions] = useState<ButtonAction[]>([
    { type: 'add_comment', body_template: 'Done ✅ ({Title})' },
  ]);
  const [buttonColor, setButtonColor] = useState('gold');
  const [expression, setExpression] = useState('');
  const databases = useDatabases(ws);
  const spaces = useSpaces(ws);
  const currentDb = useDatabase(ws, db);
  // Label relation targets "space / database" (#84): a bare name is ambiguous when
  // several spaces each have e.g. a "Projects" database.
  const relationTargets = useMemo(() => {
    const spaceName = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (databases.data ?? [])
      .map((d) => ({ id: d.id, label: `${spaceName.get(d.spaceId) ?? '—'} / ${d.name}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [databases.data, spaces.data]);
  const relationFields = (currentDb.data?.fields ?? []).filter((f) => f.type === 'relation');
  const lookupRelation = relationFields.find((f) => f.id === lookupRelationId);
  const lookupTargetDb = useDatabase(ws, lookupRelation?.relation?.target_database_id ?? '');
  const LOOKUPABLE = new Set(['title', 'text', 'number', 'checkbox', 'date', 'select', 'multi_select', 'url', 'email']);
  const lookupTargetFields = (lookupTargetDb.data?.fields ?? []).filter((f) =>
    type === 'rollup' ? f.type === 'number' : LOOKUPABLE.has(f.type),
  );

  const create = useMutation({
    mutationFn: async () => {
      if (type === 'relation') {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/relations', {
          params: { path: { ws } },
          body: {
            database_a_id: db,
            database_b_id: targetDb,
            cardinality: singleTarget ? 'one_to_many' : 'many_to_many',
            field_a_name: name,
            ...(inverseName.trim() ? { field_b_name: inverseName.trim() } : {}),
          },
        });
        if (error) throw error;
        return;
      }
      const effectiveConfig =
        type === 'lookup'
          ? { relation_field_id: lookupRelationId, target_field_api_name: lookupTargetApi }
          : type === 'rollup'
            ? { relation_field_id: lookupRelationId, op: rollupOp, ...(lookupTargetApi ? { target_field_api_name: lookupTargetApi } : {}) }
          : type === 'button'
            ? { color: buttonColor, actions: buttonActions }
            : type === 'formula'
              ? { expression }
              : config;
      const body: Record<string, unknown> = { display_name: name, type, config: effectiveConfig };
      if (type === 'select' || type === 'multi_select') {
        body.options = options.filter((o) => o.label.trim()).map(({ label, color }) => ({ label, color }));
      }
      const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/fields', {
        params: { path: { ws, db } },
        body: body as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: () => toast.error('Could not create the field'),
  });

  const isSelect = type === 'select' || type === 'multi_select';

  return (
    <DialogContent title="Add field" className="max-w-2xl">
      <form
        className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto px-1 py-0.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="field-name">Name</Label>
          <Input id="field-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Type</Label>
          <TypePicker
            value={type}
            onChange={(next) => {
              setType(next);
              setConfig({});
            }}
          />
        </div>

        <ConfigEditor type={type} config={config} onChange={setConfig} />

        {isSelect && (
          <div className="flex flex-col gap-1.5">
            <Label>Options</Label>
            <DraftOptionsEditor options={options} onChange={setOptions} />
          </div>
        )}
        {(type === 'lookup' || type === 'rollup') &&
          (relationFields.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3 text-[13px] text-muted">
              {type === 'rollup' ? 'Rollups aggregate related records' : "Lookups surface a related record's field"} — this
              database needs a relation first. Add a Relation field, then come back.
            </p>
          ) : (
            <>
              {type === 'rollup' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollup-op">Aggregation</Label>
                  <select
                    id="rollup-op"
                    className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                    value={rollupOp}
                    onChange={(e) => setRollupOp(e.target.value)}
                  >
                    <option value="count">Count linked records</option>
                    <option value="sum">Sum</option>
                    <option value="avg">Average</option>
                    <option value="min">Min</option>
                    <option value="max">Max</option>
                  </select>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lookup-relation">Through relation</Label>
                <select
                  id="lookup-relation"
                  required
                  className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                  value={lookupRelationId}
                  onChange={(e) => {
                    setLookupRelationId(e.target.value);
                    setLookupTargetApi('');
                  }}
                >
                  <option value="" disabled>
                    Pick a relation…
                  </option>
                  {relationFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.displayName} → {f.relation?.target_database_name ?? 'database'}
                    </option>
                  ))}
                </select>
              </div>
              {lookupRelation && (type !== 'rollup' || rollupOp !== 'count') && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="lookup-target">{type === 'rollup' ? 'Number field to aggregate' : 'Field to show'}</Label>
                  <select
                    id="lookup-target"
                    required
                    className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                    value={lookupTargetApi}
                    onChange={(e) => setLookupTargetApi(e.target.value)}
                  >
                    <option value="" disabled>
                      Pick a field…
                    </option>
                    {lookupTargetFields.map((f) => (
                      <option key={f.id} value={f.apiName}>
                        {f.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          ))}
        {type === 'formula' && (
          <FormulaEditor ws={ws} db={db} fields={(currentDb.data?.fields ?? []) as Field[]} expression={expression} onChange={setExpression} />
        )}
        {type === 'button' && (
          <div className="flex flex-col gap-1.5">
            <Label>When pressed</Label>
            <ButtonActionsEditor
              ws={ws}
              db={db}
              fields={(currentDb.data?.fields ?? []) as Field[]}
              actions={buttonActions}
              onChange={setButtonActions}
            />
            <Label className="mt-1">Button color</Label>
            <div className="flex gap-1">
              {COLOR_NAMES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={cn('flex h-7 w-7 items-center justify-center rounded hover:bg-hover', c === buttonColor && 'ring-1 ring-[var(--accent)]')}
                  onClick={() => setButtonColor(c)}
                >
                  <span className="h-4 w-4 rounded-full" style={{ backgroundColor: OPTION_COLORS[c] }} />
                </button>
              ))}
            </div>
          </div>
        )}
        {type === 'relation' && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="target-db">Related database</Label>
              <select
                id="target-db"
                required
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={targetDb}
                onChange={(e) => {
                  setTargetDb(e.target.value);
                  // Default the paired field's name to this database (#84) — it's required.
                  if (!inverseName.trim() && currentDb.data?.name) setInverseName(currentDb.data.name);
                }}
              >
                <option value="" disabled>
                  Pick a database…
                </option>
                {relationTargets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Each record here links to…</Label>
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="radio" checked={singleTarget} onChange={() => setSingleTarget(true)} />
                one target record (one-to-many)
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="radio" checked={!singleTarget} onChange={() => setSingleTarget(false)} />
                many target records (many-to-many)
              </label>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inverse-name">Field name on the other side</Label>
              <Input
                id="inverse-name"
                required
                placeholder={currentDb.data?.name ?? "this database's name"}
                value={inverseName}
                onChange={(e) => setInverseName(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            disabled={
              create.isPending ||
              (type === 'relation' && !targetDb) ||
              (type === 'button' && buttonActions.length === 0) ||
              (type === 'formula' && !expression.trim()) ||
              (type === 'lookup' && (!lookupRelationId || !lookupTargetApi)) ||
              (type === 'rollup' && (!lookupRelationId || (rollupOp !== 'count' && !lookupTargetApi)))
            }
          >
            Add field
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

/** Draft options for a field being created: color dot, Enter-to-add, auto palette. */
function DraftOptionsEditor({
  options,
  onChange,
}: {
  options: OptionDraft[];
  onChange: (options: OptionDraft[]) => void;
}) {
  const [pending, setPending] = useState('');

  function addPending() {
    const label = pending.trim();
    if (!label) return;
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
      toast.error('That option already exists');
      return;
    }
    onChange([...options, { key: draftKey++, label, color: nextColor(options.map((o) => o.color)) }]);
    setPending('');
  }

  return (
    <div className="flex flex-col gap-1.5">
      {options.map((option) => (
        <div key={option.key} className="flex items-center gap-2">
          <ColorDot
            color={option.color}
            onPick={(color) => onChange(options.map((o) => (o.key === option.key ? { ...o, color } : o)))}
          />
          <Input
            className="h-8"
            value={option.label}
            onChange={(e) =>
              onChange(options.map((o) => (o.key === option.key ? { ...o, label: e.target.value } : o)))
            }
          />
          <button
            type="button"
            className="p-1 text-faint hover:text-error"
            onClick={() => onChange(options.filter((o) => o.key !== option.key))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          className="h-8"
          placeholder={options.length === 0 ? 'First option…' : 'Add another…'}
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addPending();
            }
          }}
        />
        <Button type="button" variant="secondary" size="sm" onClick={addPending} disabled={!pending.trim()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/* ---------- auto-link (MN-085) ---------- */

interface ComparableField {
  id: string;
  api_name: string;
  display_name: string;
  type: string;
}
interface RelationDetail {
  cardinality: 'one_to_many' | 'many_to_many';
  auto_link: { conditions: Array<{ field_a_id: string; field_b_id: string }>; case_sensitive?: boolean } | null;
  comparable_fields_a: ComparableField[];
  comparable_fields_b: ComparableField[];
}

/** A single field-to-field match condition, oriented to the field you opened. */
interface RuleRow {
  thisId: string;
  otherId: string;
}

/**
 * Auto-link rule editor (MN-085): match a field on this database to a field on the
 * linked one; records whose values match get linked automatically. Rules are stored
 * on the relation as A/B pairs — we orient them to "this side" vs "linked side" so
 * the editor reads naturally whichever end you opened.
 */
function RelationAutoLink({ ws, relationId, side }: { ws: string; relationId: string; side: 'a' | 'b' }) {
  const qc = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ['relation-detail', ws, relationId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/relations/{rel}', {
        params: { path: { ws, rel: relationId } },
      });
      if (error) throw error;
      return data as unknown as RelationDetail;
    },
  });

  const [rows, setRows] = useState<RuleRow[]>([]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const detail = detailQuery.data;
  const thisFields = (side === 'a' ? detail?.comparable_fields_a : detail?.comparable_fields_b) ?? [];
  const otherFields = (side === 'a' ? detail?.comparable_fields_b : detail?.comparable_fields_a) ?? [];

  useEffect(() => {
    if (!detail || hydrated) return;
    const initial = (detail.auto_link?.conditions ?? []).map((c) => ({
      thisId: side === 'a' ? c.field_a_id : c.field_b_id,
      otherId: side === 'a' ? c.field_b_id : c.field_a_id,
    }));
    setRows(initial);
    setCaseSensitive(detail.auto_link?.case_sensitive ?? false);
    setHydrated(true);
  }, [detail, hydrated, side]);

  const toBody = () => {
    const complete = rows.filter((r) => r.thisId && r.otherId);
    if (complete.length === 0) return { auto_link: null };
    return {
      auto_link: {
        conditions: complete.map((r) => ({
          field_a: side === 'a' ? r.thisId : r.otherId,
          field_b: side === 'a' ? r.otherId : r.thisId,
        })),
        case_sensitive: caseSensitive,
      },
    };
  };

  const saveRules = async () => {
    const { error } = await api.PATCH('/api/v1/workspaces/{ws}/relations/{rel}', {
      params: { path: { ws, rel: relationId } },
      body: toBody() as never,
    });
    if (error) throw error;
    await qc.invalidateQueries({ queryKey: ['relation-detail', ws, relationId] });
  };

  const save = useMutation({
    mutationFn: saveRules,
    onSuccess: () => toast.success('Auto-link rules saved'),
    onError: () => toast.error('Could not save the rules'),
  });

  const run = useMutation({
    mutationFn: async () => {
      await saveRules(); // run what's on screen
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/relations/{rel}/auto-link', {
        params: { path: { ws, rel: relationId } },
      });
      if (error) throw error;
      return data as unknown as { created: number; ambiguous: number; unmatched: number; matched: number };
    },
    onSuccess: (r) => {
      setSummary(`Linked ${r.created} record${r.created === 1 ? '' : 's'} · ${r.ambiguous} ambiguous · ${r.unmatched} unmatched`);
    },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : 'Run failed';
      toast.error(msg);
    },
  });

  if (detailQuery.isLoading) return <p className="text-[12px] text-faint">Loading auto-link…</p>;
  if (!detail) return null;

  const selectCls =
    'h-8 min-w-0 flex-1 rounded-md border border-border-default bg-surface px-2 text-[13px] text-ink';

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-default bg-surface-subtle/40 p-3">
      <div className="flex items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-faint" />
        <span className="text-[13px] font-medium text-ink">Auto-link by matching fields</span>
      </div>
      <p className="text-[12px] text-faint">
        Link records automatically when every condition matches. Only text, email, url, number and date
        fields can be matched. {detail.cardinality === 'one_to_many' && 'Ambiguous matches (several targets) are skipped, never guessed.'}
      </p>

      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select
            className={selectCls}
            value={row.thisId}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, thisId: e.target.value } : r)))}
          >
            <option value="">This field…</option>
            {thisFields.map((f) => (
              <option key={f.id} value={f.id}>{f.display_name}</option>
            ))}
          </select>
          <span className="text-[12px] text-faint">=</span>
          <select
            className={selectCls}
            value={row.otherId}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, otherId: e.target.value } : r)))}
          >
            <option value="">Linked field…</option>
            {otherFields.map((f) => (
              <option key={f.id} value={f.id}>{f.display_name}</option>
            ))}
          </select>
          <button
            type="button"
            className="p-1 text-faint hover:text-error"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            aria-label="Remove condition"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRows([...rows, { thisId: '', otherId: '' }])}
          disabled={rows.length >= 5}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add condition
        </Button>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          Case-sensitive
        </label>
      </div>

      <div className="flex items-center gap-2 border-t border-border-default pt-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          Save rules
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => run.mutate()}
          disabled={run.isPending || rows.every((r) => !r.thisId || !r.otherId)}
        >
          {run.isPending ? 'Running…' : 'Run now'}
        </Button>
        {summary && <span className="text-[12px] text-muted">{summary}</span>}
      </div>
    </div>
  );
}

/* ---------- edit ---------- */

export function EditFieldDialog({
  ws,
  db,
  field,
  onDone,
  onChangeType,
}: {
  ws: string;
  db: string;
  field: Field;
  onDone: () => void;
  /** Provided by surfaces that can swap this dialog for the change-type flow. */
  onChangeType?: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const [name, setName] = useState(field.displayName);
  const [config, setConfig] = useState<Record<string, unknown>>(field.config ?? {});
  const deleteField = useDeleteField({ ws, db, field, onDone });

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {};
      if (name.trim() && name !== field.displayName) patch.display_name = name.trim();
      if (JSON.stringify(config) !== JSON.stringify(field.config ?? {})) patch.config = config;
      if (Object.keys(patch).length === 0) return;
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: field.id } },
        body: patch as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: () => toast.error('Could not save the field'),
  });

  const isSelect = field.type === 'select' || field.type === 'multi_select';
  // Relations ARE deletable (via the relations API, handled in useDeleteField) —
  // deleting drops both paired fields. Only title/system fields are undeletable.
  const canDelete = field.type !== 'title' && !field.isSystem;
  const canConvert = (CONVERTIBLE[field.type] ?? []).length > 0;
  const typeMeta = FIELD_TYPES.find((t) => t.value === field.type);

  return (
    <DialogContent title={`Edit "${field.displayName}"`} className="max-w-lg">
      <form
        className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto px-1 py-0.5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rename">Name</Label>
          <Input id="rename" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <p className="text-[12px] text-faint">
            {typeMeta?.label ?? field.type} field · API name{' '}
            <code className="text-muted">{field.apiName}</code> stays stable across renames.
          </p>
        </div>

        {field.type === 'relation' && field.relation && (
          <>
            <p className="text-[13px] text-muted">
              Links to <span className="font-medium text-ink">{field.relation.target_database_name ?? 'a database'}</span>{' '}
              ({field.relation.cardinality === 'one_to_many' ? 'one-to-many' : 'many-to-many'}). Manage
              or remove the relation from either database's schema.
            </p>
            <RelationAutoLink ws={ws} relationId={field.relation.id} side={field.relation.side} />
          </>
        )}

        <ConfigEditor type={field.type} config={config} onChange={setConfig} />

        {isSelect && (
          <div className="flex flex-col gap-1.5">
            <Label>Options</Label>
            <LiveOptionsEditor ws={ws} db={db} field={field} />
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border-default pt-3">
          <div className="flex gap-2">
            {canDelete && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-error"
                onClick={() => deleteField.mutate()}
              >
                Delete field
              </Button>
            )}
            {canConvert && onChangeType && (
              <Button type="button" variant="ghost" size="sm" onClick={onChangeType}>
                Change type…
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  );
}

/** Options on an existing field: rename inline, recolor via palette, drag to reorder, delete. */
function LiveOptionsEditor({ ws, db, field }: { ws: string; db: string; field: Field }) {
  const confirm = useConfirm();
  const { invalidate } = useFieldMutations(ws, db);
  const options = field.options ?? [];
  const [pending, setPending] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const addOption = useMutation({
    mutationFn: async (label: string) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options',
        {
          params: { path: { ws, db, field: field.id } },
          body: { label, color: nextColor(options.map((o) => o.color)) } as never,
        },
      );
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: () => toast.error('Could not add the option'),
  });

  const patchOption = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; label?: string; color?: string; position?: number }) => {
      const { error } = await api.PATCH(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
        { params: { path: { ws, db, field: field.id, option: id } }, body: body as never },
      );
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const removeOption = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.DELETE(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
        { params: { path: { ws, db, field: field.id, option: id } }, body: { confirm: false } },
      );
      if (res.error) {
        const message = (res.error as { error?: { message?: string } }).error?.message ?? '';
        if (message.includes('confirm')) {
          if (
            await confirm({
              title: 'Clear option',
              message: `${message.split('.')[0]}. Clear it from those records?`,
              confirmLabel: 'Clear',
              danger: true,
            })
          ) {
            const forced = await api.DELETE(
              '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
              { params: { path: { ws, db, field: field.id, option: id } }, body: { confirm: true } },
            );
            if (forced.error) throw forced.error;
            return;
          }
          return;
        }
        throw res.error;
      }
    },
    onSuccess: invalidate,
  });

  async function onDragEnd(event: DragEndEvent) {
    const from = options.findIndex((o) => o.id === event.active.id);
    const to = options.findIndex((o) => o.id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    const next = arrayMove(options, from, to);
    // Persist a clean 0..n sequence; lists are small.
    for (let i = 0; i < next.length; i++) {
      if (next[i]!.id !== options[i]?.id) {
        await patchOption.mutateAsync({ id: next[i]!.id, position: i });
      }
    }
  }

  function addPending() {
    const label = pending.trim();
    if (!label) return;
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
      toast.error('That option already exists');
      return;
    }
    addOption.mutate(label);
    setPending('');
  }

  return (
    <div className="flex flex-col gap-1.5">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={options.map((o) => o.id)} strategy={verticalListSortingStrategy}>
          {options.map((option) => (
            <SortableOptionRow
              key={option.id}
              option={option}
              onRecolor={(color) => patchOption.mutate({ id: option.id, color })}
              onRename={(label) => patchOption.mutate({ id: option.id, label })}
              onRemove={() => removeOption.mutate(option.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <div className="flex items-center gap-2 pl-6">
        <Input
          className="h-8"
          placeholder={options.length === 0 ? 'First option…' : 'Add another…'}
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addPending();
            }
          }}
        />
        <Button type="button" variant="secondary" size="sm" onClick={addPending} disabled={!pending.trim()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function SortableOptionRow({
  option,
  onRecolor,
  onRename,
  onRemove,
}: {
  option: { id: string; label: string; color: string };
  onRecolor: (color: string) => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-center gap-2', isDragging && 'z-10 opacity-70')}
    >
      <button
        type="button"
        className="cursor-grab touch-none p-0.5 text-faint hover:text-muted"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <ColorDot color={option.color} onPick={onRecolor} />
      <Input
        className="h-8"
        defaultValue={option.label}
        onBlur={(e) => {
          const label = e.target.value.trim();
          if (label && label !== option.label) onRename(label);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button type="button" className="p-1 text-faint hover:text-error" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ---------- change type ---------- */

export function ChangeTypeDialog({
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
  const targets = CONVERTIBLE[field.type] ?? [];
  const [target, setTarget] = useState(targets[0] ?? '');
  const [dryRun, setDryRun] = useState<{ records_affected: number; lossy_conversions: number } | null>(null);

  const check = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/change-type',
        {
          params: { path: { ws, db, field: field.id } },
          body: { type: target as never, dry_run: true },
        },
      );
      if (error) throw error;
      return data as unknown as { records_affected: number; lossy_conversions: number };
    },
    onSuccess: setDryRun,
  });

  const apply = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/change-type',
        { params: { path: { ws, db, field: field.id } }, body: { type: target as never } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success('Type changed');
      onDone();
    },
  });

  if (targets.length === 0) {
    return (
      <DialogContent title="Change type">
        <p className="text-sm text-muted">
          {field.type} fields cannot be converted. Delete the field and create a new one instead.
        </p>
        <div className="mt-4 flex justify-end">
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent title={`Change "${field.displayName}" type`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Convert {field.type} to</Label>
          <select
            className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setDryRun(null);
            }}
          >
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {dryRun ? (
          <p className="text-[13px] text-ink-secondary">
            {dryRun.records_affected} record(s) will convert.{' '}
            {dryRun.lossy_conversions > 0 ? (
              <span className="text-warning">
                {dryRun.lossy_conversions} value(s) cannot convert and will be cleared.
              </span>
            ) : (
              'No values will be lost.'
            )}
          </p>
        ) : (
          <p className="text-[13px] text-muted">Run the check to see what this conversion affects.</p>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          {dryRun ? (
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
              Convert
            </Button>
          ) : (
            <Button onClick={() => check.mutate()} disabled={check.isPending}>
              Check impact
            </Button>
          )}
        </div>
      </div>
    </DialogContent>
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


/* ---------- button actions (MN-046) ---------- */

export type ButtonAction =
  | { type: 'set_values'; values: Record<string, unknown> }
  | { type: 'create_record'; database_id: string; values: Record<string, unknown>; link_via_relation_field_id?: string }
  | { type: 'add_comment'; body_template: string }
  | { type: 'notify_user'; user: string; message: string }
  | { type: 'update_linked'; relation_field_id: string; values: Record<string, unknown> }
  | { type: 'send_webhook'; url: string; body_template?: string; headers?: Record<string, string> };

/** Compact declarative action builder: set fields / create linked record / comment. */
export function ButtonActionsEditor({
  ws,
  db,
  fields: dbFields,
  actions,
  onChange,
}: {
  ws: string;
  db: string;
  fields: Field[];
  actions: ButtonAction[];
  onChange: (actions: ButtonAction[]) => void;
}) {
  const databases = useDatabases(ws);
  const settable = dbFields.filter(
    (f) => !f.isSystem && !['title', 'relation', 'lookup', 'rollup', 'button', 'rich_text', 'created_at', 'updated_at', 'created_by'].includes(f.type),
  );
  const userFields = dbFields.filter((f) => f.type === 'user');
  const relationFields = dbFields.filter((f) => f.type === 'relation');

  function patch(i: number, next: ButtonAction) {
    onChange(actions.map((a, j) => (j === i ? next : a)));
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.map((action, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-border-default p-2">
          <div className="flex items-center gap-2">
            <select
              className="h-8 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={action.type}
              onChange={(e) => {
                const t = e.target.value;
                if (t === 'set_values') patch(i, { type: 'set_values', values: {} });
                else if (t === 'create_record') patch(i, { type: 'create_record', database_id: db, values: { name: 'New record for {Title}' } });
                else if (t === 'notify_user') patch(i, { type: 'notify_user', user: '@me', message: '' });
                else if (t === 'update_linked') patch(i, { type: 'update_linked', relation_field_id: relationFields[0]?.id ?? '', values: {} });
                else if (t === 'send_webhook') patch(i, { type: 'send_webhook', url: '' });
                else patch(i, { type: 'add_comment', body_template: '' });
              }}
            >
              <option value="set_values">Set fields on this record</option>
              <option value="create_record">Create a record</option>
              <option value="update_linked">Update linked records</option>
              <option value="add_comment">Add a comment</option>
              <option value="notify_user">Notify a person</option>
              <option value="send_webhook">Send a webhook</option>
            </select>
            <button type="button" className="p-1 text-faint hover:text-error" onClick={() => onChange(actions.filter((_, j) => j !== i))}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {action.type === 'set_values' && (
            <div className="flex flex-col gap-1">
              {Object.entries(action.values).map(([key, value]) => (
                <div key={key} className="flex items-center gap-1.5 text-[12px] text-ink">
                  <span className="w-28 truncate text-muted">{settable.find((f) => f.apiName === key)?.displayName ?? key}</span>
                  <Input
                    className="h-7"
                    value={String(value ?? '')}
                    onChange={(e) => patch(i, { ...action, values: { ...action.values, [key]: coerceActionValue(settable.find((f) => f.apiName === key), e.target.value) } })}
                  />
                  <button type="button" className="p-0.5 text-faint hover:text-error" onClick={() => {
                    const next = { ...action.values };
                    delete next[key];
                    patch(i, { ...action, values: next });
                  }}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <select
                className="h-7 self-start rounded border border-border-default bg-card px-1 text-[12px] text-muted"
                value=""
                onChange={(e) => {
                  const f = settable.find((x) => x.apiName === e.target.value);
                  if (!f) return;
                  const initial = f.type === 'user' ? '@me' : f.type === 'date' ? '@today' : f.type === 'checkbox' ? true : '';
                  patch(i, { ...action, values: { ...action.values, [f.apiName]: initial } });
                }}
              >
                <option value="">＋ field to set…</option>
                {settable.filter((f) => !(f.apiName in action.values)).map((f) => (
                  <option key={f.id} value={f.apiName}>{f.displayName}</option>
                ))}
              </select>
              <p className="text-[11px] text-faint">Tokens: @me · @today · @now. Selects take the option id or label via the API.</p>
            </div>
          )}

          {action.type === 'create_record' && (
            <div className="flex flex-col gap-1">
              <select
                className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                value={action.database_id}
                onChange={(e) => patch(i, { ...action, database_id: e.target.value, link_via_relation_field_id: undefined })}
              >
                {(databases.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <Input
                className="h-7"
                placeholder="Title template — {Title} inserts this record's title"
                value={String(action.values.name ?? '')}
                onChange={(e) => patch(i, { ...action, values: { ...action.values, name: e.target.value } })}
              />
              <LinkBackPicker ws={ws} sourceDb={db} targetDb={action.database_id} value={action.link_via_relation_field_id} onChange={(v) => patch(i, { ...action, link_via_relation_field_id: v })} />
            </div>
          )}

          {action.type === 'add_comment' && (
            <Input
              className="h-7"
              placeholder="Comment text — {Field Name} interpolates values"
              value={action.body_template}
              onChange={(e) => patch(i, { ...action, body_template: e.target.value })}
            />
          )}

          {action.type === 'send_webhook' && (
            <div className="flex flex-col gap-1">
              <Input
                className="h-7"
                type="url"
                placeholder="https://hooks.example.com/... — {Field Name} interpolates"
                value={action.url}
                onChange={(e) => patch(i, { ...action, url: e.target.value })}
              />
              <textarea
                className="min-h-[56px] rounded border border-border-default bg-card px-2 py-1 font-mono text-[12px] text-ink"
                placeholder={'Body (optional) — JSON is sent as-is, {Field Name} interpolates.\nLeave empty to send the whole record.'}
                value={action.body_template ?? ''}
                onChange={(e) => patch(i, { ...action, body_template: e.target.value || undefined })}
              />
              <p className="text-[11px] text-faint">
                Signed with the workspace webhook secret; failures retry automatically.
              </p>
            </div>
          )}

          {action.type === 'notify_user' && (
            <div className="flex flex-col gap-1">
              <select
                className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                value={action.user}
                onChange={(e) => patch(i, { ...action, user: e.target.value })}
              >
                <option value="@me">Me (whoever runs it)</option>
                {userFields.map((f) => (
                  <option key={f.id} value={f.apiName}>{f.displayName}</option>
                ))}
              </select>
              <Input
                className="h-7"
                placeholder="Message — {Field Name} interpolates values"
                value={action.message}
                onChange={(e) => patch(i, { ...action, message: e.target.value })}
              />
            </div>
          )}

          {action.type === 'update_linked' && (
            <UpdateLinkedEditor
              ws={ws}
              relationFields={relationFields}
              action={action}
              onChange={(next) => patch(i, next)}
            />
          )}
        </div>
      ))}
      <button
        type="button"
        className="flex items-center gap-1 self-start text-[13px] text-muted hover:text-ink"
        onClick={() => onChange([...actions, { type: 'add_comment', body_template: '' }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add action
      </button>
    </div>
  );
}

function coerceActionValue(field: Field | undefined, raw: string): unknown {
  if (!field) return raw;
  if (field.type === 'number') return raw === '' ? null : Number(raw);
  if (field.type === 'checkbox') return raw === 'true';
  if (field.type === 'select') {
    return field.options?.find((o) => o.label === raw)?.id ?? raw;
  }
  return raw;
}

/** Relations on the target database that point back at the source. */
function LinkBackPicker({
  ws,
  sourceDb,
  targetDb,
  value,
  onChange,
}: {
  ws: string;
  sourceDb: string;
  targetDb: string;
  value?: string;
  onChange: (v: string | undefined) => void;
}) {
  const target = useDatabase(ws, targetDb);
  const candidates = (target.data?.fields ?? []).filter(
    (f) => f.type === 'relation' && f.relation?.target_database_id === sourceDb,
  );
  if (candidates.length === 0) return null;
  return (
    <select
      className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">Don't link back</option>
      {candidates.map((f) => (
        <option key={f.id} value={f.id}>Link back via "{f.displayName}"</option>
      ))}
    </select>
  );
}

/** update_linked action editor: pick a relation, then set fields on the linked (target) records. */
function UpdateLinkedEditor({
  ws,
  relationFields,
  action,
  onChange,
}: {
  ws: string;
  relationFields: Field[];
  action: { type: 'update_linked'; relation_field_id: string; values: Record<string, unknown> };
  onChange: (next: ButtonAction) => void;
}) {
  const relField = relationFields.find((f) => f.id === action.relation_field_id);
  const targetDbId = relField?.relation?.target_database_id ?? '';
  const target = useDatabase(ws, targetDbId);
  const settable = (target.data?.fields ?? []).filter(
    (f) => !f.isSystem && !['title', 'relation', 'lookup', 'rollup', 'button', 'rich_text', 'created_at', 'updated_at', 'created_by'].includes(f.type),
  );
  if (relationFields.length === 0) {
    return <p className="text-[12px] text-faint">This database has no relations to update through.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <select
        className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
        value={action.relation_field_id}
        onChange={(e) => onChange({ ...action, relation_field_id: e.target.value, values: {} })}
      >
        {relationFields.map((f) => (
          <option key={f.id} value={f.id}>Through "{f.displayName}"</option>
        ))}
      </select>
      {Object.entries(action.values).map(([key, value]) => (
        <div key={key} className="flex items-center gap-1.5 text-[12px] text-ink">
          <span className="w-28 truncate text-muted">{settable.find((f) => f.apiName === key)?.displayName ?? key}</span>
          <Input
            className="h-7"
            value={String(value ?? '')}
            onChange={(e) => onChange({ ...action, values: { ...action.values, [key]: coerceActionValue(settable.find((f) => f.apiName === key), e.target.value) } })}
          />
          <button
            type="button"
            className="p-0.5 text-faint hover:text-error"
            onClick={() => {
              const next = { ...action.values };
              delete next[key];
              onChange({ ...action, values: next });
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      <select
        className="h-7 self-start rounded border border-border-default bg-card px-1 text-[12px] text-muted"
        value=""
        onChange={(e) => {
          const f = settable.find((x) => x.apiName === e.target.value);
          if (!f) return;
          const initial = f.type === 'user' ? '@me' : f.type === 'date' ? '@today' : f.type === 'checkbox' ? true : '';
          onChange({ ...action, values: { ...action.values, [f.apiName]: initial } });
        }}
      >
        <option value="">＋ field to set on linked…</option>
        {settable.filter((f) => !(f.apiName in action.values)).map((f) => (
          <option key={f.id} value={f.apiName}>{f.displayName}</option>
        ))}
      </select>
    </div>
  );
}


/* ---------- formula editor (MN-043) ---------- */

const FORMULA_TYPE_OF: Record<string, 'text' | 'number' | 'checkbox' | 'date' | null> = {
  number: 'number', checkbox: 'checkbox', date: 'date', created_at: 'date', updated_at: 'date',
  text: 'text', title: 'text', select: 'text', url: 'text', email: 'text', lookup: 'text',
  rollup: 'number',
};

export function FormulaEditor({
  ws,
  db,
  fields: dbFields,
  expression,
  onChange,
}: {
  ws: string;
  db: string;
  fields: Field[];
  expression: string;
  onChange: (expression: string) => void;
}) {
  const infos = dbFields
    .map((f) => {
      if (f.type === 'formula') {
        const rt = f.config['result_type'] as string | undefined;
        return rt ? { api_name: f.apiName, display_name: f.displayName, formula_type: rt as never } : null;
      }
      const ft = FORMULA_TYPE_OF[f.type];
      return ft ? { api_name: f.apiName, display_name: f.displayName, formula_type: ft } : null;
    })
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  const sample = useQuery({
    queryKey: ['formula-sample', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db }, query: { limit: 1 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ title: string; values: Record<string, unknown> }> }).data[0] ?? null;
    },
    staleTime: 60_000,
  });

  let feedback: { kind: 'ok' | 'error'; text: string } = { kind: 'ok', text: '' };
  if (expression.trim()) {
    try {
      const ast = parseFormula(expression, infos);
      const resultType = typecheck(ast, infos);
      let preview = '';
      if (sample.data) {
        const bag: Record<string, unknown> = { name: sample.data.title, ...sample.data.values };
        // Map select ids to labels so previews match server behavior.
        for (const f of dbFields) {
          if (f.type === 'select' && typeof bag[f.apiName] === 'string') {
            bag[f.apiName] = f.options?.find((o) => o.id === bag[f.apiName])?.label ?? bag[f.apiName];
          }
        }
        const value = evaluateFormula(ast, bag);
        preview = ` · preview (${sample.data.title || 'Untitled'}): ${value === null ? '—' : String(value)}`;
      }
      feedback = { kind: 'ok', text: `returns ${resultType === 'null' ? 'text' : resultType}${preview}` };
    } catch (error) {
      feedback = { kind: 'error', text: (error as Error).message };
    }
  }

  const [panel, setPanel] = useState<'none' | 'fields' | 'functions'>('none');
  const insert = (snippet: string) => onChange(expression + snippet);

  // Live autocomplete (MN-18): suggest fields inside {…} and functions on a bare word.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [ac, setAc] = useState<{ items: Array<{ label: string; hint: string; apply: () => void }>; index: number } | null>(null);
  const funcEntries = Object.entries(FORMULA_FUNCTIONS);

  function replaceRange(start: number, end: number, text: string) {
    onChange(expression.slice(0, start) + text + expression.slice(end));
    setAc(null);
    requestAnimationFrame(() => {
      const pos = start + text.length;
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  }

  function refreshSuggestions(value: string, caret: number) {
    const before = value.slice(0, caret);
    const brace = before.lastIndexOf('{');
    if (brace >= 0 && !before.slice(brace).includes('}')) {
      const partial = before.slice(brace + 1).toLowerCase();
      const items = infos
        .filter((f) => f.display_name.toLowerCase().includes(partial))
        .slice(0, 8)
        .map((f) => ({ label: f.display_name, hint: String(f.formula_type), apply: () => replaceRange(brace, caret, `{${f.display_name}}`) }));
      setAc(items.length ? { items, index: 0 } : null);
      return;
    }
    const word = before.match(/[a-zA-Z_][a-zA-Z0-9_]*$/)?.[0] ?? '';
    if (!word) return setAc(null);
    const start = caret - word.length;
    const items = funcEntries
      .filter(([name]) => name.toLowerCase().startsWith(word.toLowerCase()))
      .slice(0, 8)
      .map(([name, spec]) => ({
        label: name,
        hint: (spec as { doc?: string }).doc ?? '',
        apply: () => replaceRange(start, caret, name === 'now' || name === 'today' ? `${name}()` : `${name}(`),
      }));
    setAc(items.length ? { items, index: 0 } : null);
  }

  function onFormulaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!ac) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAc({ ...ac, index: (ac.index + 1) % ac.items.length }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAc({ ...ac, index: (ac.index - 1 + ac.items.length) % ac.items.length }); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); ac.items[ac.index]?.apply(); }
    else if (e.key === 'Escape') { e.preventDefault(); setAc(null); }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor="formula-src">Formula</Label>
        <div className="flex gap-1">
          <button
            type="button"
            className={cn('rounded px-1.5 py-0.5 text-[11px]', panel === 'fields' ? 'bg-active text-ink' : 'text-muted hover:bg-hover hover:text-ink')}
            onClick={() => setPanel((p) => (p === 'fields' ? 'none' : 'fields'))}
          >
            {'{ } Field'}
          </button>
          <button
            type="button"
            className={cn('rounded px-1.5 py-0.5 text-[11px]', panel === 'functions' ? 'bg-active text-ink' : 'text-muted hover:bg-hover hover:text-ink')}
            onClick={() => setPanel((p) => (p === 'functions' ? 'none' : 'functions'))}
          >
            ƒ Functions
          </button>
        </div>
      </div>
      <div className="relative">
        <textarea
          id="formula-src"
          ref={taRef}
          rows={3}
          className="w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-border-strong"
          placeholder={'if({Estimate} > 5, "big", "small")'}
          value={expression}
          onChange={(e) => {
            onChange(e.target.value);
            refreshSuggestions(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onFormulaKeyDown}
          onClick={(e) => refreshSuggestions(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setAc(null), 120)}
        />
        {ac && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-[var(--radius-card)] border border-border-strong bg-card shadow-lg">
            {ac.items.map((it, i) => (
              <button
                key={it.label}
                type="button"
                className={cn('flex w-full items-baseline gap-2 px-2 py-1 text-left', i === ac.index ? 'bg-active' : 'hover:bg-hover')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  it.apply();
                }}
              >
                <span className="font-mono text-[12px] text-ink">{it.label}</span>
                {it.hint && <span className="truncate text-[11px] text-muted">{it.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {panel === 'fields' && (
        <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card p-1.5">
          {infos.length === 0 && <span className="px-1 text-[12px] text-faint">No referenceable fields yet.</span>}
          {infos.map((f) => (
            <button
              key={f.api_name}
              type="button"
              className="rounded bg-hover px-1.5 py-0.5 text-[12px] text-ink hover:bg-active"
              onClick={() => {
                // If the user just typed "{", complete it; otherwise insert a full {Field}.
                onChange(expression.endsWith('{') ? `${expression}${f.display_name}}` : `${expression}{${f.display_name}}`);
                setPanel('none');
              }}
            >
              {f.display_name}
            </button>
          ))}
        </div>
      )}
      {panel === 'functions' && (
        <div className="max-h-40 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card p-1">
          {Object.entries(FORMULA_FUNCTIONS).map(([name, spec]) => (
            <button
              key={name}
              type="button"
              title={spec.example}
              className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-hover"
              onClick={() => {
                const noArgs = name === 'now' || name === 'today';
                insert(noArgs ? `${name}()` : `${name}(`);
                setPanel('none');
              }}
            >
              <span className="font-mono text-[12px] text-ink">{spec.example}</span>
              <span className="text-[11px] text-muted">{spec.doc}</span>
            </button>
          ))}
        </div>
      )}
      <p className={cn('text-[12px]', feedback.kind === 'error' ? 'text-error' : 'text-muted')}>
        {feedback.text || 'Reference fields as {Field Name}. Use the buttons above to insert fields and functions.'}
      </p>
      <a
        href="https://github.com/StoryFunnels/storyOS/blob/main/docs/product/formulas.md"
        target="_blank"
        rel="noreferrer"
        className="self-start text-[12px] text-info underline-offset-2 hover:underline"
      >
        Learn formulas →
      </a>
    </div>
  );
}
