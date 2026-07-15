'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { CalendarDays, FormInput, GanttChart, Kanban, LayoutGrid, List as ListIcon, Newspaper, Plus, Table2, X } from 'lucide-react';
import { BoardView } from '@/components/views/board-view';
import { CalendarView } from '@/components/views/calendar-view';
import { GalleryView } from '@/components/views/gallery-view';
import { ListView } from '@/components/views/list-view';
import { FeedView } from '@/components/views/feed-view';
import { TimelineView } from '@/components/views/timeline-view';
import { FormView } from '@/components/views/form-view';
import { TableView } from '@/components/table-view/table-view';
import { ViewToolbar } from '@/components/views/view-toolbar';
import {
  EMPTY_CONFIG,
  queryBodyFromConfig,
  useViewMutations,
  useViewState,
} from '@/components/views/use-view-state';
import type { ViewConfig } from '@/components/views/use-view-state';
import { useDatabase, useMembers } from '@/components/table-view/use-table-data';
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

  if (database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;

  return (
    <div className="flex h-full flex-col">
      {/* View tabs */}
      <div className="flex h-11 items-center gap-1 border-b border-border-default px-3">
        <h1 className="mr-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
          {database.data?.icon && <span className="text-[15px] leading-none">{database.data.icon}</span>}
          {database.data?.name}
        </h1>
        {views.map((view) => (
          <button
            key={view.id}
            className={cn(
              'group/tab flex items-center gap-1.5 rounded px-2 py-1 text-[13px]',
              view.id === activeView?.id
                ? 'bg-active font-medium text-ink'
                : 'text-muted hover:bg-hover hover:text-ink',
            )}
            onClick={() => router.replace(`/w/${ws}/d/${db}?view=${view.id}`)}
          >
            {view.type === 'board' ? (
              <Kanban className="h-3.5 w-3.5" />
            ) : view.type === 'calendar' ? (
              <CalendarDays className="h-3.5 w-3.5" />
            ) : view.type === 'gallery' ? (
              <LayoutGrid className="h-3.5 w-3.5" />
            ) : view.type === 'list' ? (
              <ListIcon className="h-3.5 w-3.5" />
            ) : view.type === 'feed' ? (
              <Newspaper className="h-3.5 w-3.5" />
            ) : view.type === 'timeline' ? (
              <GanttChart className="h-3.5 w-3.5" />
            ) : view.type === 'form' ? (
              <FormInput className="h-3.5 w-3.5" />
            ) : (
              <Table2 className="h-3.5 w-3.5" />
            )}
            {view.name}
            {!readOnly && views.length > 1 && view.id === activeView?.id && (
              <X
                className="h-3 w-3 text-faint opacity-0 hover:text-error group-hover/tab:opacity-100"
                onClick={async (e) => {
                  e.stopPropagation();
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
            )}
          </button>
        ))}
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
          <FormView ws={ws} db={db} config={config} readOnly={readOnly} />
        ) : (
          <TableView
            ws={ws}
            db={db}
            readOnly={readOnly}
            schemaEditable={schemaEditable}
            queryBody={queryBody}
            hiddenFieldIds={config.hidden_field_ids}
            columnWidths={config.column_widths}
            onColumnResize={(fieldId, width) =>
              patch({ column_widths: { ...config.column_widths, [fieldId]: width } })
            }
          />
        )}
      </div>
    </div>
  );
}

type ViewKind = 'table' | 'board' | 'calendar' | 'gallery' | 'list' | 'feed' | 'timeline' | 'form';

function NewViewDialog({
  fields,
  onCreate,
}: {
  fields: Array<{ id: string; displayName: string; type: string }>;
  onCreate: (name: string, type: ViewKind, configPatch?: Partial<ViewConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<ViewKind>('table');
  const dateFields = fields.filter((f) => f.type === 'date' || f.type === 'created_at' || f.type === 'updated_at');
  const [dateField, setDateField] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const selectFields = fields.filter((f) => f.type === 'select');
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
            if (!name.trim()) return;
            const patch: Partial<ViewConfig> = {};
            if (type === 'board') patch.group_by_field_id = groupBy || selectFields[0]?.id;
            if (type === 'list' && groupBy) patch.group_by_field_id = groupBy;
            if (type === 'calendar') patch.date_field_id = dateField || dateFields[0]?.id;
            if (type === 'timeline') {
              patch.start_date_field_id = startDate || dateFields[0]?.id;
              if (endDate) patch.end_date_field_id = endDate;
            }
            onCreate(name.trim(), type, patch);
            setOpen(false);
            setName('');
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="view-name">Name</Label>
            <Input id="view-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { kind: 'table', label: 'Table', Icon: Table2 },
                  { kind: 'board', label: 'Board', Icon: Kanban, need: selectFields.length === 0 ? 'Needs a select field' : null },
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
                  onClick={() => setType(kind)}
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
          {(type === 'board' || type === 'list') && selectFields.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-by">Group by{type === 'list' ? ' (optional)' : ''}</Label>
              <select
                id="group-by"
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={type === 'board' ? groupBy || selectFields[0]?.id || '' : groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
              >
                {type === 'list' && <option value="">None</option>}
                {selectFields.map((f) => (
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
