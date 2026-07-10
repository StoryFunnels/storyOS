'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, ChevronDown, ChevronRight, GripVertical, MoreHorizontal, Pin, PinOff, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useWorkspace } from '@/lib/queries';
import { atLeast } from '@/lib/access';
import { CellDisplay, CellEditor, PressButton } from '@/components/table-view/cells';
import {
  AddFieldDialog,
  ChangeTypeDialog,
  EditFieldDialog,
  useDeleteField,
} from '@/components/table-view/field-dialogs';
import { RelationEditor } from '@/components/table-view/relation-cell';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { LinkChip } from '@/components/table-view/relation-cell';
import {
  useDatabase,
  useMembers,
  useRecordMutations,
} from '@/components/table-view/use-table-data';
import type { Field, RecordRow } from '@/components/table-view/use-table-data';
import { DescriptionEditor } from '@/components/entity/description-editor';
import { ActivityPanel, AttachmentsStrip, CommentsPanel } from '@/components/entity/panels';
import { cn } from '@/lib/utils';

const HIDDEN = new Set(['title', 'created_at', 'updated_at', 'created_by']);
const NOT_INLINE = new Set(['lookup', 'rollup', 'button', 'formula']);

/** Entity-page order is independent of table columns: config.entity_order, else API (position) order. */
function orderKey(field: Field, apiIndex: number): number {
  const explicit = field.config?.['entity_order'];
  return typeof explicit === 'number' ? explicit : apiIndex;
}

export default function EntityPage() {
  const { ws, db, rec } = useParams<{ ws: string; db: string; rec: string }>();
  const workspace = useWorkspace(ws);
  const database = useDatabase(ws, db);
  const { data: session } = useSession();
  const readOnly = !atLeast(database.data?.my_access, 'editor');
  const canComment = atLeast(database.data?.my_access, 'commenter');
  const schemaEditable = atLeast(database.data?.my_access, 'creator');
  const { updateRecord } = useRecordMutations(ws, db);

  const record = useQuery({
    queryKey: ['record', ws, db, rec],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}',
        { params: { path: { ws, db, rec } } },
      );
      if (error) throw error;
      return data as unknown as RecordRow;
    },
  });

  const members = useMembers(ws, !readOnly);
  const memberList = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name, image: m.user.image })),
    [members.data],
  );
  const memberNames = useMemo(() => new Map(memberList.map((m) => [m.id, m.name])), [memberList]);
  const memberImages = useMemo(() => new Map(memberList.map((m) => [m.id, m.image])), [memberList]);

  // API index captures the position/table order — the fallback for entity ordering.
  const apiIndex = useMemo(() => {
    const map = new Map<string, number>();
    (database.data?.fields ?? []).forEach((f, i) => map.set(f.id, i));
    return map;
  }, [database.data]);

  const allFields = useMemo(
    () => (database.data?.fields ?? []).filter((f) => !HIDDEN.has(f.type)),
    [database.data],
  );
  const visibleFields = useMemo(
    () => allFields.filter((f) => f.config?.['entity_hidden'] !== true),
    [allFields],
  );
  const sortByEntity = useMemo(
    () => (list: Field[]) =>
      [...list].sort((a, b) => orderKey(a, apiIndex.get(a.id) ?? 0) - orderKey(b, apiIndex.get(b.id) ?? 0)),
    [apiIndex],
  );
  // Pinned lead in an emphasized group; the rest fill a two-column grid; rich text gets full-width sections.
  const pinnedFields = useMemo(
    () => sortByEntity(visibleFields.filter((f) => f.type !== 'rich_text' && f.config?.['entity_pinned'] === true)),
    [visibleFields, sortByEntity],
  );
  const gridFields = useMemo(
    () => sortByEntity(visibleFields.filter((f) => f.type !== 'rich_text' && f.config?.['entity_pinned'] !== true)),
    [visibleFields, sortByEntity],
  );
  const richFields = useMemo(() => visibleFields.filter((f) => f.type === 'rich_text'), [visibleFields]);
  const hiddenFields = useMemo(
    () => allFields.filter((f) => f.config?.['entity_hidden'] === true),
    [allFields],
  );
  const [showHidden, setShowHidden] = useState(false);

  const setFieldConfig = useSetFieldConfig(ws, db);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onGridDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = gridFields.findIndex((f) => f.id === event.active.id);
    const to = gridFields.findIndex((f) => f.id === event.over!.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(gridFields, from, to);
    // Write entity_order for the reordered grid only — table columns (position) stay put.
    next.forEach((f, i) => {
      if (orderKey(f, apiIndex.get(f.id) ?? 0) !== i) {
        setFieldConfig.mutate({ fieldId: f.id, config: { entity_order: i } });
      }
    });
  }

  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  if (record.isLoading || database.isLoading) {
    return <p className="p-6 text-sm text-muted">Loading…</p>;
  }
  if (!record.data) return <p className="p-6 text-sm text-error">Record not found.</p>;

  const valueProps = {
    ws,
    db,
    rec,
    record: record.data,
    members: memberList,
    memberNames,
    memberImages,
    readOnly,
    onCommit: (field: Field, value: unknown) => updateRecord.mutate({ rec, values: { [field.apiName]: value } }),
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <Link
        href={`/w/${ws}/d/${db}`}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {database.data?.name}
      </Link>

      <input
        className="mb-5 w-full bg-transparent text-2xl font-semibold text-ink outline-none placeholder:text-faint"
        placeholder="Untitled"
        value={titleDraft ?? record.data.title}
        readOnly={readOnly}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={() => {
          if (titleDraft !== null && titleDraft !== record.data!.title) {
            updateRecord.mutate({ rec, values: { name: titleDraft } });
          }
          setTitleDraft(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />

      {/* Pinned fields — the key facts, emphasized */}
      {pinnedFields.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
          {pinnedFields.map((field) => (
            <PinnedRow key={field.id} field={field} schemaEditable={schemaEditable} {...valueProps} />
          ))}
        </div>
      )}

      {/* Two-column property grid */}
      <div className="mb-6">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onGridDragEnd}>
          <SortableContext items={gridFields.map((f) => f.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
              {gridFields.map((field) => (
                <GridCell key={field.id} field={field} schemaEditable={schemaEditable} {...valueProps} />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {schemaEditable && hiddenFields.length > 0 && (
          <div className="mt-2 border-t border-border-default pt-1.5">
            <button
              className="flex items-center gap-1 text-[13px] text-faint hover:text-ink"
              onClick={() => setShowHidden((s) => !s)}
            >
              {showHidden ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {hiddenFields.length} hidden field{hiddenFields.length > 1 ? 's' : ''}
            </button>
            {showHidden &&
              hiddenFields.map((field) => (
                <HiddenFieldRow key={field.id} ws={ws} db={db} field={field} />
              ))}
          </div>
        )}
        {schemaEditable && <AddFieldRow ws={ws} db={db} />}
      </div>

      {richFields.map((field) => (
        <RichTextFieldSection
          key={field.id}
          ws={ws}
          db={db}
          field={field}
          value={record.data.values[field.apiName]}
          readOnly={readOnly}
          schemaEditable={schemaEditable}
          onCommit={(value) => updateRecord.mutate({ rec, values: { [field.apiName]: value } })}
        />
      ))}

      <div className="mb-6">
        <AttachmentsStrip ws={ws} db={db} rec={rec} readOnly={readOnly} />
      </div>

      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">
        Description
      </h2>
      <DescriptionEditor ws={ws} db={db} rec={rec} readOnly={readOnly} />

      {/* Tabs */}
      <div className="mt-8 border-t border-border-default pt-4">
        <div className="mb-4 flex gap-1">
          {(['comments', 'activity'] as const).map((t) => (
            <button
              key={t}
              className={cn(
                'rounded px-2.5 py-1 text-[13px] capitalize',
                tab === t ? 'bg-active font-medium text-ink' : 'text-muted hover:bg-hover',
              )}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === 'comments' ? (
          !canComment ? (
            <p className="text-[13px] text-muted">You can view this record but not comment on it.</p>
          ) : (
            <CommentsPanel
              ws={ws}
              db={db}
              rec={rec}
              members={memberList}
              currentUserId={session?.user.id ?? ''}
              isAdmin={workspace.data?.role === 'admin'}
            />
          )
        ) : (
          <ActivityPanel ws={ws} db={db} rec={rec} />
        )}
      </div>
    </div>
  );
}

interface ValueProps {
  ws: string;
  db: string;
  rec: string;
  record: RecordRow;
  members: Array<{ id: string; name: string; image?: string | null }>;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
  readOnly: boolean;
  onCommit: (field: Field, value: unknown) => void;
}

/** The value renderer shared by pinned rows and grid cells: inline edit for every type. */
function FieldValue({
  field,
  record,
  ws,
  db,
  rec,
  members,
  memberNames,
  memberImages,
  readOnly,
  onCommit,
}: ValueProps & { field: Field }) {
  const [editing, setEditing] = useState(false);
  const value = record.values[field.apiName];

  if (field.type === 'relation') {
    const chips = (value as LinkChip[]) ?? [];
    return (
      <div className="relative flex flex-wrap items-center gap-1">
        {chips.map((chip) => (
          <Link
            key={chip.id}
            href={`/w/${ws}/d/${field.relation!.target_database_id}/r/${chip.id}`}
            className="inline-flex max-w-48 items-center truncate rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink hover:border-border-strong"
          >
            {chip.title || 'Untitled'}
          </Link>
        ))}
        {!readOnly && (
          <button
            className="inline-flex items-center gap-0.5 rounded border border-dashed border-border-default px-1.5 py-0.5 text-[12px] text-muted hover:border-border-strong hover:text-ink"
            onClick={() => setEditing(true)}
          >
            <Plus className="h-3 w-3" /> {chips.length === 0 && 'Add'}
          </button>
        )}
        {editing && (
          <RelationEditor
            ws={ws}
            db={db}
            recordId={rec}
            field={field}
            current={chips}
            onDone={() => setEditing(false)}
          />
        )}
      </div>
    );
  }

  if (field.type === 'button') {
    return <PressButton ws={ws} db={db} recordId={rec} field={field} disabled={readOnly} />;
  }

  if (editing) {
    return (
      <CellEditor
        field={field}
        value={value}
        members={members}
        onCommit={(next) => {
          setEditing(false);
          onCommit(field, next);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const empty = value === undefined || value === null || value === '';
  return (
    <div
      className={cn('min-h-6 min-w-0', !readOnly && !NOT_INLINE.has(field.type) && 'cursor-pointer')}
      onClick={() => {
        if (readOnly || NOT_INLINE.has(field.type)) return;
        if (field.type === 'checkbox') onCommit(field, !(value === true));
        else setEditing(true);
      }}
    >
      {empty ? (
        <span className="text-[13px] text-faint">Empty</span>
      ) : (
        <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
      )}
    </div>
  );
}

/** Full-width emphasized row for a pinned field (label left, value right). */
function PinnedRow({
  field,
  schemaEditable,
  ...value
}: ValueProps & { field: Field; schemaEditable: boolean }) {
  return (
    <div className="group flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default px-3 py-2 last:border-b-0">
      <span className="flex w-32 shrink-0 items-center gap-1.5 truncate text-[13px] font-medium text-muted sm:w-40">
        <Pin className="h-3 w-3 shrink-0 text-accent" /> <span className="truncate">{field.displayName}</span>
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <FieldValue field={field} {...value} />
      </div>
      {schemaEditable && <FieldMenu ws={value.ws} db={value.db} field={field} pinned />}
    </div>
  );
}

/** Compact, draggable, label-above cell for the two-column grid. */
function GridCell({
  field,
  schemaEditable,
  ...value
}: ValueProps & { field: Field; schemaEditable: boolean }) {
  const sortable = useSortable({ id: field.id, disabled: !schemaEditable });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'group rounded-md border border-transparent px-2 py-1.5 hover:border-border-default hover:bg-hover/40',
        sortable.isDragging && 'z-10 border-border-default bg-card opacity-80 shadow-sm',
      )}
    >
      <div className="mb-0.5 flex items-center gap-1">
        {schemaEditable && (
          <button
            className="-ml-1 cursor-grab touch-none text-faint opacity-0 hover:text-muted group-hover:opacity-100"
            {...sortable.attributes}
            {...sortable.listeners}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3 w-3" />
          </button>
        )}
        <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-faint">
          {field.displayName}
        </span>
        {schemaEditable && <FieldMenu ws={value.ws} db={value.db} field={field} />}
      </div>
      <FieldValue field={field} {...value} />
    </div>
  );
}

/** Persist a merged patch onto a field's config (entity-page visibility / pin / order). */
function useSetFieldConfig(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fieldId, config }: { fieldId: string; config: Record<string, unknown> }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: fieldId } },
        body: { config },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['database', ws, db] }),
  });
}

/** Schema editing without leaving the record (Notion-style): ⋯ on each property. */
function FieldMenu({ ws, db, field, pinned = false }: { ws: string; db: string; field: Field; pinned?: boolean }) {
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const setConfig = useSetFieldConfig(ws, db);
  const canDelete = field.type !== 'relation' && !field.isSystem;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="rounded p-0.5 text-faint opacity-0 hover:bg-hover hover:text-ink group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialog('edit')}>Edit field</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              setConfig.mutate({ fieldId: field.id, config: { entity_pinned: !pinned, entity_order: null } })
            }
          >
            {pinned ? (
              <><PinOff className="mr-2 h-3.5 w-3.5" /> Unpin</>
            ) : (
              <><Pin className="mr-2 h-3.5 w-3.5" /> Pin to top</>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfig.mutate({ fieldId: field.id, config: { entity_hidden: true } })}>
            Hide on record page
          </DropdownMenuItem>
          {canDelete && (
            <DropdownMenuItem className="text-error" onSelect={() => deleteField.mutate()}>
              Delete field
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === 'edit' && (
          <EditFieldDialog
            ws={ws}
            db={db}
            field={field}
            onDone={() => setDialog(null)}
            onChangeType={() => setDialog('change-type')}
          />
        )}
        {dialog === 'change-type' && (
          <ChangeTypeDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} />
        )}
      </Dialog>
    </>
  );
}

/** Full-width BlockNote section for a rich_text field (MN-041). */
function RichTextFieldSection({
  ws,
  db,
  field,
  value,
  readOnly,
  schemaEditable,
  onCommit,
}: {
  ws: string;
  db: string;
  field: Field;
  value: unknown;
  readOnly: boolean;
  schemaEditable: boolean;
  onCommit: (value: unknown) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useCreateBlockNote({
    initialContent: Array.isArray(value) && value.length > 0 ? (value as never) : undefined,
  });
  useEffect(() => () => (timer.current !== null ? clearTimeout(timer.current) : undefined), []);

  return (
    <div className="group mb-5">
      <div className="mb-1.5 flex items-center gap-1">
        <h2 className="text-[12px] font-medium uppercase tracking-wider text-faint">
          {field.displayName}
        </h2>
        {schemaEditable && <FieldMenu ws={ws} db={db} field={field} />}
      </div>
      <div className="rounded-[var(--radius-card)] border border-border-default bg-card py-3 [&_.bn-editor]:bg-transparent">
        <BlockNoteView
          editor={editor}
          editable={!readOnly}
          theme="light"
          onChange={() => {
            if (readOnly) return;
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              const doc = editor.document;
              onCommit(doc.length > 0 ? doc : null);
            }, 800);
          }}
        />
      </div>
    </div>
  );
}

function HiddenFieldRow({ ws, db, field }: { ws: string; db: string; field: Field }) {
  const setConfig = useSetFieldConfig(ws, db);
  return (
    <div className="flex min-h-8 items-center py-1">
      <span className="w-40 shrink-0 text-[13px] text-faint">{field.displayName}</span>
      <button
        className="text-[12px] text-info underline-offset-2 hover:underline"
        onClick={() => setConfig.mutate({ fieldId: field.id, config: { entity_hidden: false } })}
      >
        Show
      </button>
    </div>
  );
}

/** "+ Add a field" under the properties — schema growth from the entity page. */
function AddFieldRow({ ws, db }: { ws: string; db: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="mt-1 flex items-center gap-1.5 self-start py-2 text-[13px] text-faint hover:text-ink">
          <Plus className="h-3.5 w-3.5" /> Add a field
        </button>
      </DialogTrigger>
      {open && <AddFieldDialog ws={ws} db={db} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}
