'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
  Calendar,
  CheckSquare,
  GripVertical,
  Hash,
  Link2,
  List,
  Pilcrow,
  Plus,
  Search,
  Tags,
  Trash2,
  Type,
  UserRound,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
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
  { value: 'relation', label: 'Relation', description: 'Link records in another database', icon: Workflow },
  { value: 'lookup', label: 'Lookup', description: "Show a related record's field here", icon: Search },
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
    <div className="grid grid-cols-2 gap-1.5">
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
}: {
  ws: string;
  db: string;
  onDone: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('text');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [targetDb, setTargetDb] = useState('');
  const [singleTarget, setSingleTarget] = useState(true);
  const [inverseName, setInverseName] = useState('');
  const [lookupRelationId, setLookupRelationId] = useState('');
  const [lookupTargetApi, setLookupTargetApi] = useState('');
  const databases = useDatabases(ws);
  const currentDb = useDatabase(ws, db);
  const relationFields = (currentDb.data?.fields ?? []).filter((f) => f.type === 'relation');
  const lookupRelation = relationFields.find((f) => f.id === lookupRelationId);
  const lookupTargetDb = useDatabase(ws, lookupRelation?.relation?.target_database_id ?? '');
  const LOOKUPABLE = new Set(['title', 'text', 'number', 'checkbox', 'date', 'select', 'multi_select', 'url', 'email']);
  const lookupTargetFields = (lookupTargetDb.data?.fields ?? []).filter((f) => LOOKUPABLE.has(f.type));

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
    <DialogContent title="Add field" className="max-w-lg">
      <form
        className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1"
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
        {type === 'lookup' &&
          (relationFields.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3 text-[13px] text-muted">
              Lookups surface a related record's field — this database needs a relation first. Add a
              Relation field, then come back.
            </p>
          ) : (
            <>
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
              {lookupRelation && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="lookup-target">Field to show</Label>
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
        {type === 'relation' && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="target-db">Related database</Label>
              <select
                id="target-db"
                required
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={targetDb}
                onChange={(e) => setTargetDb(e.target.value)}
              >
                <option value="" disabled>
                  Pick a database…
                </option>
                {(databases.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
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
              <Label htmlFor="inverse-name">Field name on the other side (optional)</Label>
              <Input
                id="inverse-name"
                placeholder="defaults to this database's name"
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
              (type === 'lookup' && (!lookupRelationId || !lookupTargetApi))
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
  const canDelete = field.type !== 'title' && field.type !== 'relation' && !field.isSystem;
  const canConvert = (CONVERTIBLE[field.type] ?? []).length > 0;
  const typeMeta = FIELD_TYPES.find((t) => t.value === field.type);

  return (
    <DialogContent title={`Edit "${field.displayName}"`} className="max-w-lg">
      <form
        className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1"
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
          <p className="text-[13px] text-muted">
            Links to <span className="font-medium text-ink">{field.relation.target_database_name ?? 'a database'}</span>{' '}
            ({field.relation.cardinality === 'one_to_many' ? 'one-to-many' : 'many-to-many'}). Manage
            or remove the relation from either database's schema.
          </p>
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
          if (window.confirm(`${message.split('.')[0]}. Clear it from those records?`)) {
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

  const del = useMutation({
    mutationFn: async () => {
      const usage = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/usage',
        { params: { path: { ws, db, field: field.id } } },
      );
      const count = (usage.data as { records_with_value: number } | undefined)?.records_with_value ?? 0;
      if (
        !window.confirm(
          count > 0
            ? `"${field.displayName}" has values on ${count} record(s). Delete anyway?`
            : `Delete "${field.displayName}"?`,
        )
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
        toast.success('Field deleted');
      }
      onDone();
    },
    onError: () => {
      toast.error('This field cannot be deleted');
      onDone();
    },
  });

  return del;
}
