'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, List, Palette, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { atLeast } from '@/lib/access';
import { CellDisplay, CellEditor, OPTION_COLORS } from '@/components/table-view/cells';
import { RelationEditor } from '@/components/table-view/relation-cell';
import type { LinkChip } from '@/components/table-view/relation-cell';
import {
  AddFilterButton,
  FilterChip,
  OPS_BY_TYPE,
  SortButton,
} from '@/components/views/view-toolbar';
import type { FilterCondition } from '@/components/views/use-view-state';
import { useDatabase } from '@/components/table-view/use-table-data';
import type { Field, RecordRow } from '@/components/table-view/use-table-data';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { recordHref } from '@/lib/records';
import { cn } from '@/lib/utils';
import { NOT_INLINE } from './entity-field-utils';
import type { CollectionView, VP } from './entity-field-utils';
import { FieldMenu, useSetFieldConfig } from './field-controls';

const COLLECTION_CAP = 20;

/** Field types worth showing inline in a relation section (MN-206). */
const INLINE_COLUMN_TYPES = new Set([
  'select',
  'multi_select',
  'user',
  'date',
  'checkbox',
  'number',
  'url',
  'email',
]);

/**
 * A to-many relation rendered as a working list in the body (MN-071), now with
 * filter / sort / color-by (MN-073). The linked records are fetched from the
 * TARGET database via the query engine — filtered to "linked to this record"
 * through the inverse relation field — so we get full values to sort/filter/color.
 */
export function CollectionSection({ field, schemaEditable, onToggleZone, readOnly, ws, db, rec, record, members, memberNames, memberImages }: VP & { field: Field }) {
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const collapsed = field.config?.['entity_collapsed'] === true;
  const setConfig = useSetFieldConfig(ws, db);
  const chips = (record.values[field.apiName] as LinkChip[]) ?? [];

  const targetDbId = field.relation?.target_database_id ?? '';
  const targetDb = useDatabase(ws, targetDbId);
  const targetFields = useMemo(() => targetDb.data?.fields ?? [], [targetDb.data]);
  const inverseApi = targetFields.find((f) => f.id === field.relation?.inverse_field_id)?.apiName;

  // MN-206 part 2 (#142): edit the LINKED records' fields in place + create pre-linked.
  // Both act on the TARGET database, so its access ladder gates them — not this one's.
  const qc = useQueryClient();
  const canEditTargets = atLeast(targetDb.data?.my_access, 'contributor');
  const [editingCell, setEditingCell] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const invalidateCollection = () => {
    void qc.invalidateQueries({ queryKey: ['collection', ws, targetDbId, rec, field.id] });
    void qc.invalidateQueries({ queryKey: ['record', ws, db, rec] });
  };
  const updateLinked = useMutation({
    mutationFn: async ({ rowId, values }: { rowId: string; values: Record<string, unknown> }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db: targetDbId, rec: rowId } },
        body: { values } as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setEditingCell(null);
      invalidateCollection();
    },
    onError: () => {
      setEditingCell(null);
      toast.error('Could not update the linked record');
    },
  });
  const createLinked = useMutation({
    mutationFn: async (title: string) => {
      const titleApi = targetFields.find((f) => f.type === 'title')?.apiName ?? 'name';
      // MN-080 inline relation write: naming the inverse field links it in the same create.
      const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDbId } },
        body: {
          values: { [titleApi]: title, ...(inverseApi ? { [inverseApi]: [rec] } : {}) },
        } as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewTitle('');
      setCreating(false);
      invalidateCollection();
    },
    onError: () => toast.error('Could not create the record'),
  });
  const cv = (field.config?.['collection_view'] as CollectionView | undefined) ?? {};
  const setCv = (patch: Partial<CollectionView>) =>
    setConfig.mutate({ fieldId: field.id, config: { collection_view: { ...cv, ...patch } } });

  const linked = useQuery({
    queryKey: ['collection', ws, targetDbId, rec, field.id, cv],
    enabled: Boolean(targetDbId && inverseApi) && !collapsed,
    queryFn: async () => {
      // Only apply conditions that are actually complete — a half-built filter (no value yet) must not 422.
      const valueless = new Set(['is_empty', 'not_empty']);
      const usable = (cv.filters?.and ?? []).filter(
        (c) =>
          valueless.has(c.op) ||
          (c.value !== undefined && c.value !== '' && !(Array.isArray(c.value) && c.value.length === 0)),
      );
      const filter = { and: [{ field: inverseApi!, op: 'has', value: [rec] }, ...usable] };
      // MN-252: same nulls-only-when-diverging-from-default rule as sortsBodyFromConfig.
      const nulls = cv.sorts?.length && cv.sorts_nulls === 'first' ? 'first' : undefined;
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
        params: { path: { ws, db: targetDbId } },
        body: { filter, sorts: cv.sorts ?? [], nulls, limit: 200 } as never,
      });
      if (error) throw error;
      return (data as unknown as { data: RecordRow[] }).data;
    },
  });
  const rows = linked.data ?? [];
  const shown = showAll ? rows : rows.slice(0, COLLECTION_CAP);
  const filtersActive = (cv.filters?.and?.length ?? 0) > 0 || (cv.sorts?.length ?? 0) > 0;
  const total = filtersActive ? rows.length : chips.length;

  const colorField = cv.color_by ? targetFields.find((f) => f.apiName === cv.color_by) : undefined;
  const dotColor = (row: RecordRow): string | null => {
    if (!colorField) return null;
    const opt = colorField.options?.find((o) => o.id === row.values[colorField.apiName]);
    return opt ? OPTION_COLORS[opt.color] ?? OPTION_COLORS.gray! : null;
  };
  const filterable = targetFields.filter((f) => OPS_BY_TYPE[f.type]);
  const conditions = cv.filters?.and ?? [];
  const setConditions = (next: FilterCondition[]) => setCv({ filters: next.length ? { and: next } : undefined });

  // Inline columns (MN-206): the linked records' own fields shown per row. Explicit
  // choice via the Fields picker, else a sensible default (first status + assignee).
  const columnCandidates = targetFields.filter((f) => INLINE_COLUMN_TYPES.has(f.type));
  const defaultColumns = useMemo(() => {
    const status = columnCandidates.find((f) => f.type === 'select');
    const person = columnCandidates.find((f) => f.type === 'user');
    return [status, person].filter((f): f is Field => Boolean(f)).map((f) => f.apiName);
  }, [columnCandidates]);
  const columnApiNames = cv.fields ?? defaultColumns;
  const columns = columnApiNames
    .map((name) => targetFields.find((f) => f.apiName === name))
    .filter((f): f is Field => f !== undefined && INLINE_COLUMN_TYPES.has(f.type));

  return (
    <div className="group mb-5">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <CollapseToggle
          collapsed={collapsed}
          onToggle={() => setConfig.mutate({ fieldId: field.id, config: { entity_collapsed: !collapsed } })}
        />
        <h2 className="text-[12px] font-medium uppercase tracking-wider text-faint">{field.displayName}</h2>
        <span className="text-[11px] text-faint">{total}</span>
        {schemaEditable && <FieldMenu field={field} onToggleZone={onToggleZone} ws={ws} db={db} collection />}
        {schemaEditable && !collapsed && targetDb.data && (
          <span className="flex flex-wrap items-center gap-1">
            {conditions.map((c, i) => (
              <FilterChip
                key={i}
                fields={filterable}
                members={members}
                condition={c}
                onChange={(next) => setConditions(conditions.map((x, j) => (j === i ? next : x)))}
                onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
              />
            ))}
            <AddFilterButton
              fields={filterable}
              onAdd={(f) => {
                const op = OPS_BY_TYPE[f.type]![0]!;
                setConditions([...conditions, { field: f.apiName, op: op.op as FilterCondition['op'], value: undefined }]);
              }}
            />
            <SortButton
              fields={targetFields}
              sorts={cv.sorts ?? []}
              nulls={cv.sorts_nulls}
              onChange={(sorts) => setCv({ sorts: sorts.length ? sorts : undefined })}
              onNullsChange={(sorts_nulls) => setCv({ sorts_nulls })}
            />
            <ColorByButton
              fields={targetFields.filter((f) => f.type === 'select')}
              value={cv.color_by}
              onChange={(color_by) => setCv({ color_by })}
            />
            <FieldsButton
              fields={columnCandidates}
              selected={columnApiNames}
              onToggle={(apiName) => {
                const set = new Set(columnApiNames);
                if (set.has(apiName)) set.delete(apiName);
                else set.add(apiName);
                setCv({ fields: [...set] });
              }}
            />
          </span>
        )}
      </div>
      {!collapsed && (
        <>
          <div
            className={cn(
              'rounded-[var(--radius-card)] border border-border-default bg-card',
              // The cell editor pops below its row — don't clip it while it's open.
              editingCell ? 'overflow-visible' : 'overflow-hidden',
            )}
          >
            {rows.length === 0 && (
              <p className="px-3 py-2.5 text-[13px] text-faint">
                {filtersActive ? 'No matches.' : 'Nothing linked yet.'}
              </p>
            )}
            {shown.map((row) => {
              const color = dotColor(row);
              return (
                // Only the TITLE area navigates — the column cells are interactive
                // editors and must never live inside the anchor (MN-206 pt 2).
                <div
                  key={row.id}
                  className="flex items-center gap-2 border-b border-border-default px-3 py-2 text-[13px] text-ink last:border-b-0 hover:bg-hover"
                >
                  <Link
                    href={recordHref(ws, targetDbId, row)}
                    className="flex min-w-0 flex-1 items-center gap-2"
                  >
                    {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
                    <span className="min-w-0 flex-1 truncate">{row.title || 'Untitled'}</span>
                  </Link>
                  {columns.map((col) => {
                    const value = row.values[col.apiName];
                    const editable = canEditTargets && !NOT_INLINE.has(col.type);
                    const isEditing = editingCell?.rowId === row.id && editingCell.fieldId === col.id;
                    if (value == null && !editable) return null;
                    return (
                      <span
                        key={col.id}
                        className={cn(
                          'relative flex max-w-[9rem] shrink-0 items-center text-[12px]',
                          editable && 'cursor-pointer rounded px-0.5 hover:bg-active',
                        )}
                        onClick={
                          editable
                            ? () => {
                                if (col.type === 'checkbox') {
                                  updateLinked.mutate({ rowId: row.id, values: { [col.apiName]: !(value === true) } });
                                } else {
                                  setEditingCell(isEditing ? null : { rowId: row.id, fieldId: col.id });
                                }
                              }
                            : undefined
                        }
                      >
                        {value != null ? (
                          <CellDisplay
                            field={col}
                            value={value}
                            memberNames={memberNames}
                            memberImages={memberImages}
                          />
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                        {isEditing && (
                          <span
                            className="absolute right-0 top-full z-30 mt-1 w-56"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="relative block min-h-8 rounded-[var(--radius-card)] border border-border-default bg-card p-1 shadow-[0_8px_24px_rgba(15,23,41,0.15)]">
                              <CellEditor
                                field={col}
                                value={value ?? null}
                                members={members}
                                onCommit={(next) => updateLinked.mutate({ rowId: row.id, values: { [col.apiName]: next } })}
                                onCancel={() => setEditingCell(null)}
                              />
                            </span>
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              );
            })}
            {rows.length > COLLECTION_CAP && (
              <button
                className="flex w-full items-center gap-1 px-3 py-2 text-[12px] text-info hover:bg-hover"
                onClick={() => setShowAll((s) => !s)}
              >
                {showAll ? 'Show less' : `Show all ${rows.length}`}
              </button>
            )}
          </div>
          {/* Add lives OUTSIDE the overflow-hidden card so its picker never clips. */}
          {!readOnly && (
            <div className="relative mt-1 flex items-center gap-3 px-1">
              <button
                className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"
                onClick={() => setAdding(true)}
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
              {canEditTargets && !creating && (
                <button
                  className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"
                  onClick={() => setCreating(true)}
                >
                  <Plus className="h-3.5 w-3.5" /> New
                </button>
              )}
              {creating && (
                <input
                  autoFocus
                  className="h-7 w-64 rounded-md border border-border-default bg-card px-2 text-[13px] text-ink"
                  placeholder={`New ${targetDb.data?.name ?? 'record'} — Enter to create, linked here`}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newTitle.trim()) createLinked.mutate(newTitle.trim());
                    if (e.key === 'Escape') {
                      setCreating(false);
                      setNewTitle('');
                    }
                  }}
                  disabled={createLinked.isPending}
                />
              )}
              {adding && (
                <RelationEditor ws={ws} db={db} recordId={rec} field={field} current={chips} onDone={() => setAdding(false)} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** "Fields" picker for a collection — choose which target fields render inline as columns (MN-206). */
function FieldsButton({
  fields,
  selected,
  onToggle,
}: {
  fields: Field[];
  selected: string[];
  onToggle: (apiName: string) => void;
}) {
  if (fields.length === 0) return null;
  const selectedSet = new Set(selected);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-hover hover:text-ink',
            selected.length ? 'text-ink' : 'text-muted',
          )}
        >
          <List className="h-3.5 w-3.5" /> Fields
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {fields.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={(e) => { e.preventDefault(); onToggle(f.apiName); }}>
            {selectedSet.has(f.apiName) ? '✓ ' : '  '}
            {f.displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Color by" picker for a collection — colors rows by a target select field (MN-073). */
function ColorByButton({
  fields,
  value,
  onChange,
}: {
  fields: Field[];
  value: string | undefined;
  onChange: (apiName: string | undefined) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-hover hover:text-ink',
            value ? 'text-ink' : 'text-muted',
          )}
        >
          <Palette className="h-3.5 w-3.5" /> Color
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onChange(undefined)}>None</DropdownMenuItem>
        {fields.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onChange(f.apiName)}>
            {value === f.apiName ? '✓ ' : ''}
            {f.displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Chevron that collapses/expands a field or section (persisted in config.entity_collapsed). */
export function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      className="-ml-1 rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
      onClick={onToggle}
      title={collapsed ? 'Expand' : 'Collapse'}
    >
      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );
}
