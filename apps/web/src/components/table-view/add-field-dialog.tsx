'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases, useSpaces } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { OPTION_COLORS } from './cells';
import { useDatabase, useMembers } from './use-table-data';
import type { Field } from './use-table-data';
import {
  COLOR_NAMES,
  ConfigEditor,
  TypePicker,
  useFieldMutations,
} from './field-dialog-shared';
import type { OptionDraft } from './field-dialog-shared';
import { DraftOptionsEditor } from './option-editors';
import { FormulaEditor } from './formula-editor';
import { ButtonActionsEditor } from './button-actions-editor';
import type { ButtonAction } from './button-actions-editor';
// MN-295: reuse the SAME filter-condition builder saved views use, rather
// than a second filter UI for the Rollup's optional filter.
import { OPS_BY_TYPE, FilterBuilderPanel } from '../views/view-toolbar';
import { buildFilterGroup, filterConditions, filterConnector } from '../views/filter-config';
import type { FilterGroup } from '../views/filter-config';

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
  // MN-295: the rollup's optional filter, in the same {and:[...]}/{or:[...]}
  // tree shape ViewConfig.filters already uses — collapses to `undefined`
  // (no filter — unconditional aggregate, same as before MN-295) when empty.
  const [rollupFilter, setRollupFilter] = useState<FilterGroup | undefined>(undefined);
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
  // MN-212: display names are unique per database — flag a duplicate before submit.
  const duplicateName = useMemo(() => {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return false;
    return (currentDb.data?.fields ?? []).some((f) => f.displayName.trim().toLowerCase() === wanted);
  }, [name, currentDb.data]);
  const lookupRelation = relationFields.find((f) => f.id === lookupRelationId);
  const lookupTargetDb = useDatabase(ws, lookupRelation?.relation?.target_database_id ?? '');
  const LOOKUPABLE = new Set(['title', 'text', 'number', 'checkbox', 'date', 'select', 'multi_select', 'url', 'email']);
  const lookupTargetFields = (lookupTargetDb.data?.fields ?? []).filter((f) =>
    type === 'rollup' ? f.type === 'number' : LOOKUPABLE.has(f.type),
  );
  // MN-295: the rollup filter builder operates over the RELATED database's
  // fields (same "filterable" gate FiltersSection uses — OPS_BY_TYPE), and
  // needs member names for its "me"/user-field pickers.
  const rollupFilterableFields = (lookupTargetDb.data?.fields ?? []).filter((f) => OPS_BY_TYPE[f.type]);
  const rollupMembers = useMembers(ws, type === 'rollup');
  const rollupMemberList = useMemo(
    () => (rollupMembers.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name })),
    [rollupMembers.data],
  );
  const rollupFilterConnector = filterConnector(rollupFilter);
  const rollupFilterNodes = filterConditions(rollupFilter);

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
            ? {
                relation_field_id: lookupRelationId,
                op: rollupOp,
                ...(lookupTargetApi ? { target_field_api_name: lookupTargetApi } : {}),
                ...(rollupFilter ? { filter: rollupFilter } : {}),
              }
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
          {duplicateName && (
            <p className="text-[12px] text-error">A field named “{name.trim()}” already exists in this database.</p>
          )}
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
                    setRollupFilter(undefined); // MN-295: filter fields belong to the OLD relation's target db
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
              {type === 'rollup' && lookupRelation && (
                <div className="flex flex-col gap-1.5">
                  <Label>Filter (optional)</Label>
                  <p className="text-[12px] text-faint">
                    Only aggregate linked records matching this condition — e.g. State is not Done.
                  </p>
                  <div className="rounded-[var(--radius-card)] border border-border-default">
                    <FilterBuilderPanel
                      fields={rollupFilterableFields}
                      members={rollupMemberList}
                      ws={ws}
                      connector={rollupFilterConnector}
                      nodes={rollupFilterNodes}
                      onNodesChange={(next) => setRollupFilter(buildFilterGroup(rollupFilterConnector, next))}
                      onConnectorChange={(next) => setRollupFilter(buildFilterGroup(next, rollupFilterNodes))}
                    />
                  </div>
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
                  // For a SELF-relation both fields land here, so that default would
                  // collide with the main name; leave it for the presets instead (MN-211).
                  if (e.target.value !== db && !inverseName.trim() && currentDb.data?.name) {
                    setInverseName(currentDb.data.name);
                  }
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
            {targetDb === db && (
              <div className="flex flex-col gap-1.5">
                <Label>Common pairs</Label>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ['Blocks', 'Blocked by'],
                      ['Depends on', 'Dependency of'],
                      ['Parent', 'Sub-items'],
                    ] as const
                  ).map(([a, b]) => (
                    <button
                      key={a}
                      type="button"
                      className="rounded-full border border-border-default px-2.5 py-1 text-[12px] text-ink hover:bg-hover"
                      onClick={() => {
                        setName(a);
                        setInverseName(b);
                        // "Parent" means each record has ONE parent (one-to-many); the
                        // dependency pairs are naturally many-to-many.
                        setSingleTarget(a === 'Parent');
                      }}
                    >
                      {a} / {b}
                    </button>
                  ))}
                </div>
                <p className="text-[12px] text-faint">
                  A self-relation puts both fields on this database — name each direction clearly.
                </p>
              </div>
            )}
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
                placeholder={
                  targetDb === db ? 'e.g. Blocked by' : (currentDb.data?.name ?? "this database's name")
                }
                value={inverseName}
                onChange={(e) => setInverseName(e.target.value)}
              />
              {targetDb === db &&
                name.trim() &&
                name.trim().toLowerCase() === inverseName.trim().toLowerCase() && (
                  <p className="text-[12px] text-error">
                    The two sides of a self-relation need different names.
                  </p>
                )}
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
              duplicateName ||
              (type === 'relation' && !targetDb) ||
              (type === 'relation' &&
                targetDb === db &&
                name.trim().toLowerCase() === inverseName.trim().toLowerCase()) ||
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
