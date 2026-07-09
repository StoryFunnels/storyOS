'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, ChevronDown, ChevronRight, GripVertical, MoreHorizontal, Plus } from 'lucide-react';
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

  const allFields = useMemo(
    () => (database.data?.fields ?? []).filter((f) => !HIDDEN.has(f.type)),
    [database.data],
  );
  const visibleFields = useMemo(
    () => allFields.filter((f) => f.config?.['entity_hidden'] !== true),
    [allFields],
  );
  // Rich text gets full-width sections (like Description), not 40px rows.
  const fields = useMemo(() => visibleFields.filter((f) => f.type !== 'rich_text'), [visibleFields]);
  const richFields = useMemo(() => visibleFields.filter((f) => f.type === 'rich_text'), [visibleFields]);
  const hiddenFields = useMemo(
    () => allFields.filter((f) => f.config?.['entity_hidden'] === true),
    [allFields],
  );
  const [showHidden, setShowHidden] = useState(false);

  const qc = useQueryClient();
  const reorder = useMutation({
    mutationFn: async (moves: Array<{ fieldId: string; position: number }>) => {
      for (const move of moves) {
        const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
          params: { path: { ws, db, field: move.fieldId } },
          body: { position: move.position },
        });
        if (error) throw error;
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['database', ws, db] }),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onFieldDragEnd(event: DragEndEvent) {
    const full = database.data?.fields ?? [];
    const fromField = fields.find((f) => f.id === event.active.id);
    const toField = fields.find((f) => f.id === event.over?.id);
    if (!fromField || !toField || fromField.id === toField.id) return;
    const next = arrayMove(full, full.indexOf(fromField), full.indexOf(toField));
    const moves = next
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => full[i]?.id !== f.id && !f.isSystem)
      .map(({ f, i }) => ({ fieldId: f.id, position: i }));
    if (moves.length) reorder.mutate(moves);
  }

  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  if (record.isLoading || database.isLoading) {
    return <p className="p-6 text-sm text-muted">Loading…</p>;
  }
  if (!record.data) return <p className="p-6 text-sm text-error">Record not found.</p>;

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

      {/* Properties panel */}
      <div className="mb-6 flex flex-col">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onFieldDragEnd}>
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {fields.map((field) => (
              <PropertyRow
                key={field.id}
                ws={ws}
                db={db}
                rec={rec}
                field={field}
                record={record.data!}
                memberNames={memberNames}
                memberImages={memberImages}
                members={memberList}
                readOnly={readOnly}
                schemaEditable={schemaEditable}
                onCommit={(value) => updateRecord.mutate({ rec, values: { [field.apiName]: value } })}
              />
            ))}
          </SortableContext>
        </DndContext>

        {schemaEditable && hiddenFields.length > 0 && (
          <div className="border-b border-border-default py-1.5">
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

function PropertyRow({
  ws,
  db,
  rec,
  field,
  record,
  memberNames,
  memberImages,
  members,
  readOnly,
  schemaEditable,
  onCommit,
}: {
  ws: string;
  db: string;
  rec: string;
  field: Field;
  record: RecordRow;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
  members: Array<{ id: string; name: string; image?: string | null }>;
  readOnly: boolean;
  schemaEditable: boolean;
  onCommit: (value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const value = record.values[field.apiName];
  const sortable = useSortable({ id: field.id, disabled: !schemaEditable });
  const sortableStyle = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const grip = schemaEditable ? (
    <button
      className="-ml-5 w-5 cursor-grab touch-none self-center text-faint opacity-0 hover:text-muted group-hover:opacity-100"
      {...sortable.attributes}
      {...sortable.listeners}
      onClick={(e) => e.stopPropagation()}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  ) : null;

  if (field.type === 'relation') {
    const chips = (value as LinkChip[]) ?? [];
    return (
      <div
        ref={sortable.setNodeRef}
        style={sortableStyle}
        className={cn(
          'group flex min-h-9 items-center border-b border-border-default py-1.5 last:border-b-0',
          sortable.isDragging && 'z-10 bg-card opacity-80',
        )}
      >
        {grip}
        <span className="w-40 shrink-0 text-[13px] text-muted">{field.displayName}</span>
        <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {chips.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {chips.map((chip) => (
                <Link
                  key={chip.id}
                  href={`/w/${ws}/d/${field.relation!.target_database_id}/r/${chip.id}`}
                  className="inline-flex max-w-48 items-center truncate rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink hover:border-border-strong"
                >
                  {chip.title || 'Untitled'}
                </Link>
              ))}
            </span>
          ) : (
            <span className="text-[13px] text-faint">—</span>
          )}
          {!readOnly && (
            <button className="text-[12px] text-info underline" onClick={() => setEditing(true)}>
              edit
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
        {schemaEditable && <FieldMenu ws={ws} db={db} field={field} />}
      </div>
    );
  }

  return (
    <div
      ref={sortable.setNodeRef}
      style={sortableStyle}
      className={cn(
        'group flex min-h-9 items-center border-b border-border-default py-1.5 last:border-b-0',
        sortable.isDragging && 'z-10 bg-card opacity-80',
      )}
      onClick={() => {
        if (['lookup', 'rollup', 'button', 'formula'].includes(field.type)) return; // not inline-editable
        if (!readOnly && !editing && field.type !== 'checkbox') setEditing(true);
        if (!readOnly && field.type === 'checkbox') onCommit(!(value === true));
      }}
    >
      {grip}
      <span className="w-40 shrink-0 text-[13px] text-muted">{field.displayName}</span>
      <div className="relative min-h-6 min-w-0 flex-1 cursor-pointer">
        {editing ? (
          <CellEditor
            field={field}
            value={value}
            members={members}
            onCommit={(next) => {
              setEditing(false);
              onCommit(next);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : field.type === 'button' ? (
          <PressButton ws={ws} db={db} recordId={rec} field={field} disabled={readOnly} />
        ) : value === undefined || value === null || value === '' ? (
          <span className="text-[13px] text-faint">Empty</span>
        ) : (
          <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
        )}
      </div>
      {schemaEditable && <FieldMenu ws={ws} db={db} field={field} />}
    </div>
  );
}

/** Persist the per-database entity-page visibility flag (MN-042). */
function useSetEntityHidden(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fieldId, hidden }: { fieldId: string; hidden: boolean }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: fieldId } },
        body: { config: { entity_hidden: hidden } },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['database', ws, db] }),
  });
}

/** Schema editing without leaving the record (Notion-style): ⋯ on each property row. */
function FieldMenu({ ws, db, field }: { ws: string; db: string; field: Field }) {
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const setHidden = useSetEntityHidden(ws, db);
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
          <DropdownMenuItem onSelect={() => setHidden.mutate({ fieldId: field.id, hidden: true })}>
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
  const setHidden = useSetEntityHidden(ws, db);
  return (
    <div className="flex min-h-8 items-center py-1">
      <span className="w-40 shrink-0 text-[13px] text-faint">{field.displayName}</span>
      <button
        className="text-[12px] text-info underline-offset-2 hover:underline"
        onClick={() => setHidden.mutate({ fieldId: field.id, hidden: false })}
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
        <button className="flex items-center gap-1.5 self-start py-2 text-[13px] text-faint hover:text-ink">
          <Plus className="h-3.5 w-3.5" /> Add a field
        </button>
      </DialogTrigger>
      {open && <AddFieldDialog ws={ws} db={db} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}
