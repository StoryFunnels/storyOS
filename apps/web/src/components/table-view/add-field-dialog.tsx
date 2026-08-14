'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
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
  // #286: first/last ("latest / earliest") orders the linked records by this
  // field and reads the target field off the ONE that wins. Only meaningful for
  // those two ops — cleared whenever the op or relation changes.
  const [rollupOrderBy, setRollupOrderBy] = useState('');
  // MN-295: the rollup's optional filter, in the same {and:[...]}/{or:[...]}
  // tree shape ViewConfig.filters already uses — collapses to `undefined`
  // (no filter — unconditional aggregate, same as before MN-295) when empty.
  const [rollupFilter, setRollupFilter] = useState<FilterGroup | undefined>(undefined);
  // #151: keep the two power-user relation controls tucked away by default —
  // the rollup's optional filter, and the exact link cardinality wording.
  const [showRollupFilter, setShowRollupFilter] = useState(false);
  const [showRelationAdvanced, setShowRelationAdvanced] = useState(false);
  const [buttonActions, setButtonActions] = useState<ButtonAction[]>([
    { type: 'add_comment', body_template: 'Done ✅ ({Title})' },
  ]);
  const [buttonColor, setButtonColor] = useState('gold');
  const [expression, setExpression] = useState('');
  // #190: percent-format a number formula so it renders as a progress bar.
  const [formulaFormat, setFormulaFormat] = useState<'plain' | 'percent'>('plain');
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
  // #172: a database may have at most one Workflow field — disable the type (and
  // block submit) when one already exists, mirroring the server's one-per-DB rule.
  const hasWorkflowField = (currentDb.data?.fields ?? []).some((f) => f.type === 'workflow');
  const disabledTypes = hasWorkflowField
    ? { workflow: 'This database already has a Workflow field' }
    : undefined;
  // MN-212: display names are unique per database — flag a duplicate before submit.
  const duplicateName = useMemo(() => {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return false;
    return (currentDb.data?.fields ?? []).some((f) => f.displayName.trim().toLowerCase() === wanted);
  }, [name, currentDb.data]);
  const lookupRelation = relationFields.find((f) => f.id === lookupRelationId);
  const lookupTargetDb = useDatabase(ws, lookupRelation?.relation?.target_database_id ?? '');
  // #311: a lookup of a related record's State is as valid as any other select.
  const LOOKUPABLE = new Set(['title', 'text', 'number', 'checkbox', 'date', 'select', 'workflow', 'multi_select', 'url', 'email']);
  // #286: a first/last rollup RETURNS a field rather than aggregating one, so
  // any lookupable type is fair game — unlike sum/avg/min/max, which need a number.
  const pickOne = type === 'rollup' && (rollupOp === 'first' || rollupOp === 'last');
  const lookupTargetFields = (lookupTargetDb.data?.fields ?? []).filter((f) =>
    type === 'rollup' && !pickOne ? f.type === 'number' : LOOKUPABLE.has(f.type),
  );
  // Mirrors FieldsService.ROLLUP_ORDER_BY_TYPES: a single stored, comparable
  // value. Formulas/rollups/lookups are excluded server-side (not materialized
  // reliably), so they're not offered here either.
  const ORDERABLE = new Set(['title', 'text', 'number', 'checkbox', 'date', 'select', 'workflow', 'url', 'email', 'id', 'created_at', 'updated_at']);
  const rollupOrderFields = (lookupTargetDb.data?.fields ?? []).filter((f) => ORDERABLE.has(f.type));
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
                ...(pickOne && rollupOrderBy ? { order_by_field_api_name: rollupOrderBy } : {}),
                ...(rollupFilter ? { filter: rollupFilter } : {}),
              }
          : type === 'button'
            ? { color: buttonColor, actions: buttonActions }
            : type === 'formula'
              ? { expression, ...(formulaFormat === 'percent' ? { format: 'percent' } : {}) }
              : config;
      const body: Record<string, unknown> = { display_name: name, type, config: effectiveConfig };
      if (type === 'select' || type === 'multi_select' || type === 'workflow') {
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

  const isSelect = type === 'select' || type === 'multi_select' || type === 'workflow';

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
            disabledTypes={disabledTypes}
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
                  <Label htmlFor="rollup-op">Calculate</Label>
                  <select
                    id="rollup-op"
                    className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                    value={rollupOp}
                    onChange={(e) => setRollupOp(e.target.value)}
                  >
                    <optgroup label="Aggregate them">
                      <option value="count">Count linked records</option>
                      <option value="sum">Sum</option>
                      <option value="avg">Average</option>
                      <option value="min">Min</option>
                      <option value="max">Max</option>
                    </optgroup>
                    {/* #286: a separate group because these do something
                        categorically different — they pick ONE record and read a
                        field off it, rather than reducing a column. */}
                    <optgroup label="Pick one of them">
                      <option value="last">Latest (highest order value)</option>
                      <option value="first">Earliest (lowest order value)</option>
                    </optgroup>
                  </select>
                  {pickOne && (
                    <p className="text-[11px] text-muted">
                      Orders the linked records by a field, then shows something from that single record — e.g. “Last
                      Ticket” or “Owner of the most recent Order”.
                    </p>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lookup-relation">Using the link…</Label>
                <select
                  id="lookup-relation"
                  required
                  className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                  value={lookupRelationId}
                  onChange={(e) => {
                    setLookupRelationId(e.target.value);
                    setLookupTargetApi('');
                    setRollupOrderBy(''); // #286: order-by field belongs to the OLD relation's target db too
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
              {pickOne && lookupRelation && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollup-order-by">Ordered by</Label>
                  <select
                    id="rollup-order-by"
                    required
                    className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                    value={rollupOrderBy}
                    onChange={(e) => setRollupOrderBy(e.target.value)}
                  >
                    <option value="" disabled>
                      Pick a field…
                    </option>
                    {rollupOrderFields.map((f) => (
                      <option key={f.id} value={f.apiName}>
                        {f.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {lookupRelation && (type !== 'rollup' || rollupOp !== 'count') && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="lookup-target">
                    {pickOne ? 'Show which field of it' : type === 'rollup' ? 'Number field to aggregate' : 'Field to show'}
                  </Label>
                  <select
                    id="lookup-target"
                    required={!pickOne}
                    className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                    value={lookupTargetApi}
                    onChange={(e) => setLookupTargetApi(e.target.value)}
                  >
                    {/* #286: "no field" is a real, useful choice here — it makes the
                        rollup a link to the record itself, so "Last Ticket" is clickable. */}
                    <option value="" disabled={!pickOne}>
                      {pickOne ? 'A link to the record itself' : 'Pick a field…'}
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
                  <button
                    type="button"
                    className="flex w-fit items-center gap-1 text-[12px] font-medium text-muted hover:text-ink"
                    aria-expanded={showRollupFilter}
                    onClick={() => setShowRollupFilter((s) => !s)}
                  >
                    {showRollupFilter ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    Only include some items…
                  </button>
                  {showRollupFilter && (
                    <>
                      <p className="text-[12px] text-faint">
                        Only count linked items matching this condition — e.g. State is not Done.
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
                    </>
                  )}
                </div>
              )}
            </>
          ))}
        {type === 'formula' && (
          <FormulaEditor
            ws={ws}
            db={db}
            fields={(currentDb.data?.fields ?? []) as Field[]}
            expression={expression}
            onChange={setExpression}
            format={formulaFormat}
            onFormatChange={setFormulaFormat}
          />
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
              <Label>Each item links to…</Label>
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="radio" checked={singleTarget} onChange={() => setSingleTarget(true)} />
                one item{showRelationAdvanced && <span className="text-faint"> (one-to-many)</span>}
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="radio" checked={!singleTarget} onChange={() => setSingleTarget(false)} />
                many items{showRelationAdvanced && <span className="text-faint"> (many-to-many)</span>}
              </label>
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-[12px] font-medium text-muted hover:text-ink"
                aria-expanded={showRelationAdvanced}
                onClick={() => setShowRelationAdvanced((s) => !s)}
              >
                {showRelationAdvanced ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Advanced
              </button>
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
              (type === 'workflow' && hasWorkflowField) ||
              (type === 'relation' && !targetDb) ||
              (type === 'relation' &&
                targetDb === db &&
                name.trim().toLowerCase() === inverseName.trim().toLowerCase()) ||
              (type === 'button' && buttonActions.length === 0) ||
              (type === 'formula' && !expression.trim()) ||
              (type === 'lookup' && (!lookupRelationId || !lookupTargetApi)) ||
              (type === 'rollup' &&
                (!lookupRelationId ||
                  // #286: first/last needs the ORDER-BY field; its target field is
                  // optional (omitted = link to the record).
                  (pickOne ? !rollupOrderBy : rollupOp !== 'count' && !lookupTargetApi)))
            }
          >
            Add field
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
