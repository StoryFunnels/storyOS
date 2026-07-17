'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CalendarDays, FormInput, GanttChart, Kanban, LayoutGrid, List as ListIcon, Newspaper, Plus, Table2 } from 'lucide-react';
import { BoardView } from '@/components/views/board-view';
import { CalendarView } from '@/components/views/calendar-view';
import { GalleryView } from '@/components/views/gallery-view';
import { ListView } from '@/components/views/list-view';
import { FeedView } from '@/components/views/feed-view';
import { TimelineView } from '@/components/views/timeline-view';
import { FormView } from '@/components/views/form-view';
import { TableView } from '@/components/table-view/table-view';
import { EntityIconChip } from '@/components/ui/icon-picker';
import { ViewToolbar } from '@/components/views/view-toolbar';
import { ViewTab } from '@/components/views/view-tab';
import {
  EMPTY_CONFIG,
  queryBodyFromConfig,
  useViewMutations,
  useViewState,
} from '@/components/views/use-view-state';
import type { ViewConfig } from '@/components/views/use-view-state';
import { useDatabase, useMembers } from '@/components/table-view/use-table-data';
import type { Field } from '@/components/table-view/use-table-data';
import { atLeast } from '@/lib/access';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

function DatabasePageInner() {
  const confirm = useConfirm();
  const { ws, db } = useParams<{ ws: string; db: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const database = useDatabase(ws, db);
  const readOnly = !atLeast(database.data?.my_access, 'editor');
  const schemaEditable = atLeast(database.data?.my_access, 'creator');

  const viewId = searchParams.get('view');
  const { views, activeView, config, patch } = useViewState(ws, db, database.data, viewId, readOnly);
  const viewMutations = useViewMutations(ws, db);
  const members = useMembers(ws, !readOnly);
  const memberList = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name, image: m.user.image })),
    [members.data],
  );

  const queryBody = useMemo(() => queryBodyFromConfig(config), [config]);

  const viewSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  function onViewDragEnd(e: DragEndEvent) {
    if (readOnly || !e.over || e.active.id === e.over.id) return;
    const from = views.findIndex((v) => v.id === e.active.id);
    const to = views.findIndex((v) => v.id === e.over!.id);
    if (from < 0 || to < 0) return;
    // Persist only the views whose index actually changed (the run between from/to).
    const moves = arrayMove(views, from, to)
      .map((v, i) => ({ id: v.id, position: i }))
      .filter(({ id }, i) => views[i]?.id !== id);
    if (moves.length) viewMutations.reorderViews.mutate(moves);
  }

  if (database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;

  return (
    <div className="flex h-full flex-col">
      {/* View tabs */}
      <div className="flex h-11 items-center gap-1 border-b border-border-default px-3">
        <h1 className="mr-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
          {database.data?.icon && (
            <EntityIconChip
              icon={database.data.icon}
              color={database.data.color ?? null}
              size={15}
              fallback={null}
              className={database.data.color ? 'h-6 w-6' : undefined}
            />
          )}
          {database.data?.name}
        </h1>
        <DndContext sensors={viewSensors} collisionDetection={closestCenter} onDragEnd={onViewDragEnd}>
          <SortableContext items={views.map((v) => v.id)} strategy={horizontalListSortingStrategy}>
            {views.map((view) => (
              <ViewTab
                key={view.id}
                view={view}
                isActive={view.id === activeView?.id}
                canManage={!readOnly}
                canDelete={!readOnly && views.length > 1}
                mutations={viewMutations}
                onNavigate={() => router.replace(`/w/${ws}/d/${db}?view=${view.id}`)}
                onDuplicated={(id) => router.replace(`/w/${ws}/d/${db}?view=${id}`)}
                onDelete={async () => {
                  if (
                    !(await confirm({
                      title: `Delete view "${view.name}"?`,
                      message: 'The view is removed. Records are not affected.',
                      confirmLabel: 'Delete',
                      danger: true,
                    }))
                  )
                    return;
                  viewMutations.deleteView.mutate(view.id);
                  router.replace(`/w/${ws}/d/${db}`);
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
        {!readOnly && database.data && (
          <NewViewDialog
            fields={database.data.fields}
            onCreate={(name, type, configPatch) =>
              viewMutations.createView.mutate(
                { name, type, config: { ...EMPTY_CONFIG, ...configPatch } },
                { onSuccess: (v) => router.replace(`/w/${ws}/d/${db}?view=${v.id}`) },
              )
            }
          />
        )}
      </div>

      <ViewToolbar
        fields={database.data?.fields ?? []}
        config={config}
        members={memberList}
        viewType={activeView?.type}
        onPatch={patch}
        ws={ws}
        db={db}
        viewId={activeView?.id}
      />

      <div className="min-h-0 flex-1">
        {activeView?.type === 'board' ? (
          <BoardView ws={ws} db={db} config={config} readOnly={readOnly} />
        ) : activeView?.type === 'calendar' ? (
          <CalendarView ws={ws} db={db} config={config} readOnly={readOnly} />
        ) : activeView?.type === 'gallery' ? (
          <GalleryView ws={ws} db={db} config={config} readOnly={readOnly} />
        ) : activeView?.type === 'list' ? (
          <ListView ws={ws} db={db} config={config} readOnly={readOnly} />
        ) : activeView?.type === 'feed' ? (
          <FeedView ws={ws} db={db} config={config} readOnly={readOnly} />
        ) : activeView?.type === 'timeline' ? (
          <TimelineView ws={ws} db={db} config={config} readOnly={readOnly} />
        ) : activeView?.type === 'form' ? (
          <FormView ws={ws} db={db} config={config} readOnly={readOnly} onPatch={patch} viewId={activeView?.id} />
        ) : (
          <TableView
            ws={ws}
            db={db}
            readOnly={readOnly}
            schemaEditable={schemaEditable}
            queryBody={queryBody}
            hiddenFieldIds={config.hidden_field_ids}
            columnWidths={config.column_widths}
            config={config}
            onPatch={patch}
            onColumnResize={(fieldId, width) =>
              // Round at the source: a drag yields fractional px, which the saved
              // config rejects — and auto-save would then retry it forever (#78).
              patch({
                column_widths: {
                  ...config.column_widths,
                  [fieldId]: Math.min(1200, Math.max(40, Math.round(width))),
                },
              })
            }
          />
        )}
      </div>
    </div>
  );
}

type ViewKind = 'table' | 'board' | 'calendar' | 'gallery' | 'list' | 'feed' | 'timeline' | 'form';

const VIEW_KIND_LABEL: Record<ViewKind, string> = {
  table: 'Table',
  board: 'Board',
  calendar: 'Calendar',
  gallery: 'Gallery',
  list: 'List',
  feed: 'Feed',
  timeline: 'Timeline',
  form: 'Form',
};
const VIEW_KIND_LABELS = Object.values(VIEW_KIND_LABEL);

function NewViewDialog({
  fields,
  onCreate,
}: {
  fields: Field[];
  onCreate: (name: string, type: ViewKind, configPatch?: Partial<ViewConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(VIEW_KIND_LABEL.table);
  const [type, setType] = useState<ViewKind>('table');

  // MN-222: prefill the name from the picked type, but never clobber a name the
  // user typed — only overwrite when the field is empty or still holds a type default.
  function selectType(kind: ViewKind) {
    setName((prev) => (prev.trim() === '' || VIEW_KIND_LABELS.includes(prev.trim()) ? VIEW_KIND_LABEL[kind] : prev));
    setType(kind);
  }
  const dateFields = fields.filter((f) => f.type === 'date' || f.type === 'created_at' || f.type === 'updated_at');
  const [dateField, setDateField] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const selectFields = fields.filter((f) => f.type === 'select');
  // MN-079: a board column per value needs a single-valued field — select, a single
  // user, or the single side of a one-to-many relation. The API enforces the same rule.
  const boardGroupFields = fields.filter(
    (f) =>
      f.type === 'select' ||
      (f.type === 'user' && f.config?.['multi'] !== true) ||
      (f.type === 'relation' &&
        f.relation?.cardinality === 'one_to_many' &&
        f.relation?.side === 'a'),
  );
  const [groupBy, setGroupBy] = useState('');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-1 rounded px-2 py-1 text-[13px] text-muted hover:bg-hover hover:text-ink">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent title="New view">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            // Empty is never sent — fall back to the type's label (MN-222).
            const finalName = name.trim() || VIEW_KIND_LABEL[type];
            const patch: Partial<ViewConfig> = {};
            if (type === 'board') patch.group_by_field_id = groupBy || boardGroupFields[0]?.id;
            if (type === 'list' && groupBy) patch.group_by_field_id = groupBy;
            if (type === 'calendar') patch.date_field_id = dateField || dateFields[0]?.id;
            if (type === 'timeline') {
              patch.start_date_field_id = startDate || dateFields[0]?.id;
              if (endDate) patch.end_date_field_id = endDate;
            }
            onCreate(finalName, type, patch);
            setOpen(false);
            setName(VIEW_KIND_LABEL[type]);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="view-name">Name</Label>
            <Input id="view-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { kind: 'table', label: 'Table', Icon: Table2 },
                  { kind: 'board', label: 'Board', Icon: Kanban, need: boardGroupFields.length === 0 ? 'Needs a select, user, or one-to-many relation field' : null },
                  { kind: 'calendar', label: 'Calendar', Icon: CalendarDays, need: dateFields.length === 0 ? 'Needs a date field' : null },
                  { kind: 'gallery', label: 'Gallery', Icon: LayoutGrid },
                  { kind: 'list', label: 'List', Icon: ListIcon },
                  { kind: 'feed', label: 'Feed', Icon: Newspaper },
                  { kind: 'timeline', label: 'Timeline', Icon: GanttChart, need: dateFields.length === 0 ? 'Needs a date field' : null },
                  { kind: 'form', label: 'Form', Icon: FormInput },
                ] as Array<{ kind: ViewKind; label: string; Icon: typeof Table2; need?: string | null }>
              ).map(({ kind, label, Icon, need }) => (
                <button
                  key={kind}
                  type="button"
                  disabled={Boolean(need)}
                  title={need ?? undefined}
                  onClick={() => selectType(kind)}
                  className={cn(
                    'flex h-16 flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border text-[13px]',
                    type === kind ? 'border-[var(--accent)] bg-accent-soft text-ink' : 'border-border-default text-muted',
                    need && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                  {need && <span className="text-[10px] text-faint">{need}</span>}
                </button>
              ))}
            </div>
          </div>
          {type === 'timeline' && (
            <div className="flex gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="start-date">Start date</Label>
                <select
                  id="start-date"
                  className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                  value={startDate || dateFields[0]?.id || ''}
                  onChange={(e) => setStartDate(e.target.value)}
                >
                  {dateFields.map((f) => (
                    <option key={f.id} value={f.id}>{f.displayName}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="end-date">End date (optional)</Label>
                <select
                  id="end-date"
                  className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                >
                  <option value="">None</option>
                  {dateFields.map((f) => (
                    <option key={f.id} value={f.id}>{f.displayName}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {type === 'calendar' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="date-field">Date field</Label>
              <select
                id="date-field"
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={dateField || dateFields[0]?.id || ''}
                onChange={(e) => setDateField(e.target.value)}
              >
                {dateFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}
          {((type === 'board' && boardGroupFields.length > 0) || (type === 'list' && selectFields.length > 0)) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-by">Group by{type === 'list' ? ' (optional)' : ''}</Label>
              <select
                id="group-by"
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={type === 'board' ? groupBy || boardGroupFields[0]?.id || '' : groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
              >
                {type === 'list' && <option value="">None</option>}
                {(type === 'board' ? boardGroupFields : selectFields).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Create view</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function DatabasePage() {
  return (
    <Suspense>
      <DatabasePageInner />
    </Suspense>
  );
}
