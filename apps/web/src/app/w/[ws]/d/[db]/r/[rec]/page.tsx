'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  GripVertical,
  MoreHorizontal,
  Palette,
  Pin,
  Plus,
  SlidersHorizontal,
  Star,
  Trash2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useTheme } from '@/lib/theme';
import { useWorkspace } from '@/lib/queries';
import { atLeast } from '@/lib/access';
import { CellDisplay, CellEditor, OPTION_COLORS, PressButton } from '@/components/table-view/cells';
import {
  AddFilterButton,
  FilterChip,
  OPS_BY_TYPE,
  SORTABLE,
  SortButton,
} from '@/components/views/view-toolbar';
import type { FilterCondition, SortSpec } from '@/components/views/use-view-state';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { LinkChip } from '@/components/table-view/relation-cell';
import { useDatabase, useMembers, useRecordMutations } from '@/components/table-view/use-table-data';
import type { Field, RecordRow } from '@/components/table-view/use-table-data';
import { DescriptionEditor } from '@/components/entity/description-editor';
import { ActivityPanel, AttachmentsStrip, CommentsPanel } from '@/components/entity/panels';
import { useFavorites } from '@/components/sidebar';
import { parseRecordParam, recordHref } from '@/lib/records';
import { uploadEditorImage } from '@/lib/editor-upload';
import { cn } from '@/lib/utils';

const HIDDEN = new Set(['id', 'title', 'created_at', 'updated_at', 'created_by']);
const NOT_INLINE = new Set(['lookup', 'rollup', 'button', 'formula']);

type Zone = 'top' | 'sidebar' | 'body';
const ZONE_LABEL: Record<Zone, string> = { top: 'top strip', sidebar: 'sidebar', body: 'main body' };

/** A to-many relation is a collection — it belongs in the body as a list, never the top/sidebar. */
function isCollection(f: Field): boolean {
  return f.type === 'relation' && (f.relation?.cardinality === 'many_to_many' || f.relation?.side === 'b');
}
function defaultZone(f: Field): Zone {
  if (f.type === 'rich_text' || isCollection(f)) return 'body';
  return 'sidebar'; // scalars + single references
}
/**
 * Which zones a field shows in (MN-077). A movable field can live in several
 * zones at once (e.g. sidebar AND top). Collections & rich text are body-locked.
 * Reads `entity_zones` (array); falls back to the legacy single `entity_zone`,
 * then the type default.
 */
function zonesOf(f: Field): Zone[] {
  if (f.type === 'rich_text' || isCollection(f)) return ['body'];
  const zs = f.config?.['entity_zones'];
  if (Array.isArray(zs)) {
    const valid = zs.filter((z): z is Zone => z === 'top' || z === 'sidebar' || z === 'body');
    if (valid.length) return valid;
  }
  const legacy = f.config?.['entity_zone'];
  if (legacy === 'top' || legacy === 'sidebar' || legacy === 'body') return [legacy];
  return [defaultZone(f)];
}
function orderKey(f: Field, apiIndex: number): number {
  const explicit = f.config?.['entity_order'];
  return typeof explicit === 'number' ? explicit : apiIndex;
}
function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}
/** Hidden outright, or flagged hide-when-empty and currently empty. */
function isHidden(f: Field, record: RecordRow): boolean {
  if (f.config?.['entity_hidden'] === true) return true;
  return f.config?.['hide_when_empty'] === true && isEmptyValue(record.values[f.apiName]);
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
      // Resolve either a legacy UUID or a pretty `slug-{number}` URL (MN-087).
      const parsed = parseRecordParam(rec);
      if (parsed.kind === 'number') {
        const { data, error } = await api.GET(
          '/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}',
          { params: { path: { ws, db, number: String(parsed.value) } } } as never,
        );
        if (error) throw error;
        return data as unknown as RecordRow;
      }
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db, rec: parsed.value } },
      });
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
    () => (record.data ? allFields.filter((f) => !isHidden(f, record.data!)) : []),
    [allFields, record.data],
  );
  const byOrder = useMemo(
    () => (list: Field[]) =>
      [...list].sort((a, b) => orderKey(a, apiIndex.get(a.id) ?? 0) - orderKey(b, apiIndex.get(b.id) ?? 0)),
    [apiIndex],
  );
  const topFields = useMemo(() => byOrder(visibleFields.filter((f) => zonesOf(f).includes('top'))), [visibleFields, byOrder]);
  const sidebarFields = useMemo(() => byOrder(visibleFields.filter((f) => zonesOf(f).includes('sidebar'))), [visibleFields, byOrder]);
  const bodyFields = useMemo(() => byOrder(visibleFields.filter((f) => zonesOf(f).includes('body'))), [visibleFields, byOrder]);
  // Fields eligible to be pinned to the top strip (movable, not already there).
  const topCandidates = useMemo(
    () => visibleFields.filter((f) => f.type !== 'rich_text' && !isCollection(f) && !zonesOf(f).includes('top')),
    [visibleFields],
  );
  const hiddenFields = useMemo(
    () => (record.data ? allFields.filter((f) => isHidden(f, record.data!)) : []),
    [allFields, record.data],
  );
  const [showHidden, setShowHidden] = useState(false);

  const setFieldConfig = useSetFieldConfig(ws, db);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function reorderWithin(list: Field[], event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = list.findIndex((f) => f.id === event.active.id);
    const to = list.findIndex((f) => f.id === event.over!.id);
    if (from < 0 || to < 0) return;
    arrayMove(list, from, to).forEach((f, i) => {
      if (orderKey(f, apiIndex.get(f.id) ?? 0) !== i) {
        setFieldConfig.mutate({ fieldId: f.id, config: { entity_order: i } });
      }
    });
  }
  /** Toggle a field's presence in a zone (MN-077). Unchecking the last zone hides the field. */
  const toggleZone = (field: Field, zone: Zone) => {
    const cur = zonesOf(field);
    const next = cur.includes(zone) ? cur.filter((z) => z !== zone) : [...cur, zone];
    if (next.length === 0) setFieldConfig.mutate({ fieldId: field.id, config: { entity_hidden: true } });
    else setFieldConfig.mutate({ fieldId: field.id, config: { entity_zones: next, entity_hidden: false } });
  };

  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  if (record.isLoading || database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (!record.data) return <p className="p-6 text-sm text-error">Record not found.</p>;

  // The route param can be a pretty `slug-{number}` (MN-087); every child + mutation
  // must use the resolved UUID, never the raw param.
  const recordId = record.data.id;

  const vp = {
    ws,
    db,
    rec: recordId,
    record: record.data,
    members: memberList,
    memberNames,
    memberImages,
    readOnly,
    schemaEditable,
    onToggleZone: toggleZone,
    onCommit: (field: Field, value: unknown) => updateRecord.mutate({ rec: recordId, values: { [field.apiName]: value } }),
  };

  return (
    <div className="px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link
            href={`/w/${ws}/d/${db}`}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {database.data?.name}
          </Link>
          {record.data.number !== null && (
            <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] tabular-nums text-faint" title="Public id">
              #{record.data.number}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <StarButton ws={ws} rec={recordId} />
          {schemaEditable && <FieldsPopover ws={ws} db={db} fields={allFields} />}
          <RecordActions ws={ws} db={db} rec={recordId} readOnly={readOnly} canCreate={schemaEditable} />
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* MAIN BODY: title, pinned strip, collections + rich sections, description, discussion */}
        <div className="min-w-0 flex-1">
          <input
            className="mb-4 w-full bg-transparent text-2xl font-semibold text-ink outline-none placeholder:text-faint"
            placeholder="Untitled"
            value={titleDraft ?? record.data.title}
            readOnly={readOnly}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              if (titleDraft !== null && titleDraft !== record.data!.title) {
                updateRecord.mutate({ rec: recordId, values: { name: titleDraft } });
              }
              setTitleDraft(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />

          {/* Top strip — a few pinned essentials; shown (with an add affordance) so it's discoverable */}
          {(topFields.length > 0 || schemaEditable) && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => reorderWithin(topFields, e)}>
              <SortableContext items={topFields.map((f) => f.id)} strategy={horizontalListSortingStrategy}>
                <div className="mb-5 flex flex-wrap items-center gap-2">
                  {topFields.map((field) => (
                    <TopChip key={field.id} field={field} {...vp} />
                  ))}
                  {schemaEditable && (
                    <TopStripAdd candidates={topCandidates} empty={topFields.length === 0} onPick={(f) => toggleZone(f, 'top')} />
                  )}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {/* Body fields: collections (lists), scalars-in-body, rich text — in order */}
          {bodyFields.map((field) =>
            field.type === 'rich_text' ? (
              <RichTextFieldSection
                key={field.id}
                ws={ws}
                db={db}
                field={field}
                value={record.data.values[field.apiName]}
                readOnly={readOnly}
                schemaEditable={schemaEditable}
                onToggleZone={toggleZone}
                onCommit={(value) => updateRecord.mutate({ rec: recordId, values: { [field.apiName]: value } })}
              />
            ) : field.type === 'relation' ? (
              <CollectionSection key={field.id} field={field} {...vp} />
            ) : (
              <BodyScalar key={field.id} field={field} {...vp} />
            ),
          )}

          <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">Description</h2>
          <DescriptionEditor ws={ws} db={db} rec={recordId} readOnly={readOnly} />

          <div className="mb-6 mt-5">
            <AttachmentsStrip ws={ws} db={db} rec={recordId} readOnly={readOnly} />
          </div>

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
                  rec={recordId}
                  members={memberList}
                  currentUserId={session?.user.id ?? ''}
                  isAdmin={workspace.data?.role === 'admin'}
                />
              )
            ) : (
              <ActivityPanel ws={ws} db={db} rec={recordId} />
            )}
          </div>
        </div>

        {/* RIGHT SIDEBAR: scalar properties */}
        <aside className="w-full shrink-0 lg:sticky lg:top-6 lg:w-72">
          <div className="rounded-[var(--radius-card)] border border-border-default bg-card">
            <div className="flex items-center justify-between border-b border-border-default px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Properties</span>
              {schemaEditable && (
                <FieldPicker
                  label="Add a property"
                  candidates={visibleFields.filter((f) => !zonesOf(f).includes('sidebar') && !isCollection(f) && f.type !== 'rich_text')}
                  onPick={(f) => toggleZone(f, 'sidebar')}
                />
              )}
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => reorderWithin(sidebarFields, e)}>
              <SortableContext items={sidebarFields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col p-1.5">
                  {sidebarFields.length === 0 && (
                    <p className="px-1.5 py-2 text-[12px] text-faint">No sidebar properties.</p>
                  )}
                  {sidebarFields.map((field) => (
                    <SidebarField key={field.id} field={field} {...vp} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {schemaEditable && hiddenFields.length > 0 && (
              <div className="border-t border-border-default px-3 py-1.5">
                <button
                  className="flex items-center gap-1 text-[12px] text-faint hover:text-ink"
                  onClick={() => setShowHidden((s) => !s)}
                >
                  {showHidden ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {hiddenFields.length} hidden
                </button>
                {showHidden &&
                  hiddenFields.map((field) => <HiddenFieldRow key={field.id} ws={ws} db={db} field={field} />)}
              </div>
            )}
            {schemaEditable && (
              <div className="border-t border-border-default px-3 py-1.5">
                <AddFieldRow ws={ws} db={db} />
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

interface VP {
  ws: string;
  db: string;
  rec: string;
  record: RecordRow;
  members: Array<{ id: string; name: string; image?: string | null }>;
  memberNames: Map<string, string>;
  memberImages?: Map<string, string | null>;
  readOnly: boolean;
  schemaEditable: boolean;
  onToggleZone: (field: Field, zone: Zone) => void;
  onCommit: (field: Field, value: unknown) => void;
}

/** Inline value renderer for scalar fields (sidebar, top strip, body). */
function ScalarValue({ field, record, ws, db, rec, members, memberNames, memberImages, readOnly, onCommit }: VP & { field: Field }) {
  const [editing, setEditing] = useState(false);
  const value = record.values[field.apiName];

  if (field.type === 'relation') {
    // Single reference (collections render as their own body section).
    const chips = (value as LinkChip[]) ?? [];
    return (
      <div className="relative flex flex-wrap items-center gap-1">
        {chips.map((chip) => (
          <Link
            key={chip.id}
            href={recordHref(ws, field.relation!.target_database_id, chip)}
            className="inline-flex max-w-full items-center truncate rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink hover:border-border-strong"
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
          <RelationEditor ws={ws} db={db} recordId={rec} field={field} current={chips} onDone={() => setEditing(false)} />
        )}
      </div>
    );
  }
  if (field.type === 'button') return <PressButton ws={ws} db={db} recordId={rec} field={field} disabled={readOnly} />;
  if (editing) {
    // relative anchor so absolute-positioned option lists / pickers drop under the field
    return (
      <div className="relative min-h-6">
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
      </div>
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

/** Compact draggable property in the right sidebar (label above value). */
function SidebarField({ field, schemaEditable, onToggleZone, ...vp }: VP & { field: Field }) {
  const sortable = useSortable({ id: field.id, disabled: !schemaEditable });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const collapsed = field.config?.['entity_collapsed'] === true;
  const setConfig = useSetFieldConfig(vp.ws, vp.db);
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'group rounded-md px-1.5 py-1.5 hover:bg-hover/50',
        sortable.isDragging && 'z-10 bg-card opacity-80 shadow-sm',
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
        <CollapseToggle
          collapsed={collapsed}
          onToggle={() => setConfig.mutate({ fieldId: field.id, config: { entity_collapsed: !collapsed } })}
        />
        <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-faint">
          {field.displayName}
        </span>
        {schemaEditable && <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />}
      </div>
      {!collapsed && <ScalarValue field={field} schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />}
    </div>
  );
}

/** Pinned essential in the top strip (label + value inline). */
function TopChip({ field, schemaEditable, onToggleZone, ...vp }: VP & { field: Field }) {
  const sortable = useSortable({ id: field.id, disabled: !schemaEditable });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-2 rounded-md border border-border-default bg-card px-2.5 py-1.5',
        sortable.isDragging && 'z-10 opacity-80 shadow-sm',
      )}
      {...(schemaEditable ? sortable.attributes : {})}
      {...(schemaEditable ? sortable.listeners : {})}
    >
      <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-faint">
        <Pin className="h-3 w-3 text-accent" /> {field.displayName}
      </span>
      <div onPointerDown={(e) => e.stopPropagation()}>
        <ScalarValue field={field} schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />
      </div>
      {schemaEditable && (
        <span onPointerDown={(e) => e.stopPropagation()}>
          <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />
        </span>
      )}
    </div>
  );
}

/** A scalar field the user moved into the main body (full-width, label left). */
function BodyScalar({ field, schemaEditable, onToggleZone, ...vp }: VP & { field: Field }) {
  return (
    <div className="group mb-4 flex items-start gap-3 border-b border-border-default pb-3">
      <span className="flex w-40 shrink-0 items-center gap-1 pt-0.5 text-[12px] font-medium uppercase tracking-wide text-faint">
        {field.displayName}
        {schemaEditable && <FieldMenu field={field} onToggleZone={onToggleZone} ws={vp.ws} db={vp.db} />}
      </span>
      <div className="min-w-0 flex-1">
        <ScalarValue field={field} schemaEditable={schemaEditable} onToggleZone={onToggleZone} {...vp} />
      </div>
    </div>
  );
}

const COLLECTION_CAP = 20;

interface CollectionView {
  filters?: { and: FilterCondition[] };
  sorts?: SortSpec[];
  color_by?: string; // target select field api_name
}

/**
 * A to-many relation rendered as a working list in the body (MN-071), now with
 * filter / sort / color-by (MN-073). The linked records are fetched from the
 * TARGET database via the query engine — filtered to "linked to this record"
 * through the inverse relation field — so we get full values to sort/filter/color.
 */
function CollectionSection({ field, schemaEditable, onToggleZone, readOnly, ws, db, rec, record, members }: VP & { field: Field }) {
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const collapsed = field.config?.['entity_collapsed'] === true;
  const setConfig = useSetFieldConfig(ws, db);
  const chips = (record.values[field.apiName] as LinkChip[]) ?? [];

  const targetDbId = field.relation?.target_database_id ?? '';
  const targetDb = useDatabase(ws, targetDbId);
  const targetFields = useMemo(() => targetDb.data?.fields ?? [], [targetDb.data]);
  const inverseApi = targetFields.find((f) => f.id === field.relation?.inverse_field_id)?.apiName;
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
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
        params: { path: { ws, db: targetDbId } },
        body: { filter, sorts: cv.sorts ?? [], limit: 200 } as never,
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
              fields={targetFields.filter((f) => SORTABLE.has(f.type))}
              sorts={cv.sorts ?? []}
              onChange={(sorts) => setCv({ sorts: sorts.length ? sorts : undefined })}
            />
            <ColorByButton
              fields={targetFields.filter((f) => f.type === 'select')}
              value={cv.color_by}
              onChange={(color_by) => setCv({ color_by })}
            />
          </span>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
            {rows.length === 0 && (
              <p className="px-3 py-2.5 text-[13px] text-faint">
                {filtersActive ? 'No matches.' : 'Nothing linked yet.'}
              </p>
            )}
            {shown.map((row) => {
              const color = dotColor(row);
              return (
                <Link
                  key={row.id}
                  href={recordHref(ws, targetDbId, row)}
                  className="flex items-center gap-2 border-b border-border-default px-3 py-2 text-[13px] text-ink last:border-b-0 hover:bg-hover"
                >
                  {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
                  <span className="truncate">{row.title || 'Untitled'}</span>
                </Link>
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
            <div className="relative mt-1 px-1">
              <button
                className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"
                onClick={() => setAdding(true)}
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
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
function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
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

/** Persist a merged patch onto a field's config (zone / order / hidden). */
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

/** Dropdown that pulls an existing field into a zone. */
function FieldPicker({
  label,
  candidates,
  onPick,
}: {
  label: string;
  candidates: Field[];
  onPick: (f: Field) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink" title={label}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {candidates.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onPick(f)}>
            {f.displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Empty/populate affordance for the top strip — pin any movable field up top (MN-077). */
function TopStripAdd({
  candidates,
  empty,
  onPick,
}: {
  candidates: Field[];
  empty: boolean;
  onPick: (f: Field) => void;
}) {
  if (candidates.length === 0 && !empty) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-default px-2 py-1.5 text-[12px] text-muted hover:border-border-strong hover:text-ink"
          title="Pin a field to the top strip"
        >
          <Pin className="h-3 w-3" /> {empty ? 'Pin a field' : 'Pin'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-faint">All fields already pinned.</p>
        ) : (
          candidates.map((f) => (
            <DropdownMenuItem key={f.id} onSelect={() => onPick(f)}>
              {f.displayName}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Per-field ⋯ menu: choose zones (a field can be in several), edit, hide, delete. */
function FieldMenu({
  ws,
  db,
  field,
  onToggleZone,
  collection = false,
}: {
  ws: string;
  db: string;
  field: Field;
  onToggleZone: (field: Field, zone: Zone) => void;
  collection?: boolean;
}) {
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const setConfig = useSetFieldConfig(ws, db);
  const canDelete = field.type !== 'relation' && !field.isSystem;
  // Collections & rich text are body-locked; scalars & single-refs can be shown in any zones.
  const zones = collection ? [] : zonesOf(field);

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
          {!collection &&
            (['top', 'sidebar', 'body'] as Zone[]).map((z) => (
              <DropdownMenuItem
                key={z}
                onSelect={(e) => {
                  e.preventDefault();
                  onToggleZone(field, z);
                }}
              >
                <span className="mr-2 w-3 text-accent">{zones.includes(z) ? '✓' : ''}</span> Show in {ZONE_LABEL[z]}
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              setConfig.mutate({
                fieldId: field.id,
                config: { hide_when_empty: field.config?.['hide_when_empty'] !== true },
              })
            }
          >
            {field.config?.['hide_when_empty'] === true ? 'Always show (even empty)' : 'Hide when empty'}
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
          <EditFieldDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} onChangeType={() => setDialog('change-type')} />
        )}
        {dialog === 'change-type' && <ChangeTypeDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} />}
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
  onToggleZone,
  onCommit,
}: {
  ws: string;
  db: string;
  field: Field;
  value: unknown;
  readOnly: boolean;
  schemaEditable: boolean;
  onToggleZone: (field: Field, zone: Zone) => void;
  onCommit: (value: unknown) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { resolved: theme } = useTheme();
  const editor = useCreateBlockNote({
    initialContent: Array.isArray(value) && value.length > 0 ? (value as never) : undefined,
    uploadFile: (file: File) => uploadEditorImage(ws, file),
  });
  useEffect(() => () => (timer.current !== null ? clearTimeout(timer.current) : undefined), []);

  return (
    <div className="group mb-5">
      <div className="mb-1.5 flex items-center gap-1">
        <h2 className="text-[12px] font-medium uppercase tracking-wider text-faint">{field.displayName}</h2>
        {schemaEditable && <FieldMenu ws={ws} db={db} field={field} onToggleZone={onToggleZone} collection />}
      </div>
      <div className="rounded-[var(--radius-card)] border border-border-default bg-card py-3 [&_.bn-editor]:bg-transparent">
        <BlockNoteView
          editor={editor}
          editable={!readOnly}
          theme={theme}
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
  // Clear whichever flag hid it: an explicit hide, or hide-when-empty.
  const reveal = () =>
    setConfig.mutate({
      fieldId: field.id,
      config: field.config?.['entity_hidden'] === true ? { entity_hidden: false } : { hide_when_empty: false },
    });
  const reason = field.config?.['entity_hidden'] === true ? '' : ' (empty)';
  return (
    <div className="flex min-h-7 items-center justify-between py-0.5">
      <span className="truncate text-[12px] text-faint">
        {field.displayName}
        {reason}
      </span>
      <button className="text-[12px] text-info underline-offset-2 hover:underline" onClick={reveal}>
        Show
      </button>
    </div>
  );
}

/** "+ Add a field" — schema growth from the record page (creates a NEW field). */
function AddFieldRow({ ws, db }: { ws: string; db: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-1.5 py-1 text-[12px] text-faint hover:text-ink">
          <Plus className="h-3.5 w-3.5" /> New field
        </button>
      </DialogTrigger>
      {open && <AddFieldDialog ws={ws} db={db} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}

/** Star toggle in the header — adds/removes this record from the sidebar Favorites (MN-075). */
function StarButton({ ws, rec }: { ws: string; rec: string }) {
  const qc = useQueryClient();
  const favorites = useFavorites(ws);
  const starred = (favorites.data ?? []).some((f) => f.target_type === 'record' && f.target_id === rec);
  const toggle = useMutation({
    mutationFn: async () => {
      if (starred) {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/favorites/{type}/{id}', {
          params: { path: { ws, type: 'record', id: rec } },
        } as never);
        if (error) throw error;
      } else {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/favorites', {
          params: { path: { ws } },
          body: { target_type: 'record', target_id: rec } as never,
        } as never);
        if (error) throw error;
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['favorites', ws] }),
  });
  return (
    <button
      onClick={() => toggle.mutate()}
      title={starred ? 'Unstar' : 'Star'}
      className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
    >
      <Star className={cn('h-4 w-4', starred && 'fill-[var(--accent)] text-[var(--accent)]')} />
    </button>
  );
}

/** Header Actions menu: duplicate, copy link, delete (MN-074). */
function RecordActions({
  ws,
  db,
  rec,
  readOnly,
  canCreate,
}: {
  ws: string;
  db: string;
  rec: string;
  readOnly: boolean;
  canCreate: boolean;
}) {
  const router = useRouter();
  const qc = useQueryClient();

  const duplicate = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/duplicate',
        { params: { path: { ws, db, rec } } } as never,
      );
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (r) => {
      toast.success('Record duplicated');
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
      router.push(`/w/${ws}/d/${db}/r/${r.id}`);
    },
    onError: () => toast.error('Could not duplicate'),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db, rec } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Record moved to trash');
      router.push(`/w/${ws}/d/${db}`);
      // Drop the deleted record's queries (don't refetch a 404); refresh the list.
      qc.removeQueries({ predicate: (query) => Array.isArray(query.queryKey) && query.queryKey.includes(rec) });
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
    },
    onError: () => toast.error('Could not delete'),
  });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy link');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" title="Actions">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canCreate && (
          <DropdownMenuItem onSelect={() => duplicate.mutate()}>
            <CopyPlus className="mr-2 h-3.5 w-3.5" /> Duplicate
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={copyLink}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Copy link
        </DropdownMenuItem>
        {!readOnly && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-error" onSelect={() => remove.mutate()}>
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Fields" popover: one place to toggle which fields show on the record (MN-074). */
function FieldsPopover({ ws, db, fields }: { ws: string; db: string; fields: Field[] }) {
  const setConfig = useSetFieldConfig(ws, db);
  const [q, setQ] = useState('');
  const list = fields.filter((f) => f.displayName.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-muted hover:bg-hover hover:text-ink">
          <SlidersHorizontal className="h-3.5 w-3.5" /> Fields
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <input
          autoFocus
          placeholder="Filter fields…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="mb-1 w-full rounded border border-border-default bg-card px-2 py-1 text-[13px] text-ink outline-none placeholder:text-faint"
        />
        <div className="max-h-72 overflow-y-auto">
          {list.map((f) => {
            const shown = f.config?.['entity_hidden'] !== true;
            return (
              <DropdownMenuItem
                key={f.id}
                onSelect={(e) => {
                  e.preventDefault();
                  setConfig.mutate({ fieldId: f.id, config: { entity_hidden: shown } });
                }}
              >
                <span
                  className={cn(
                    'flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
                    shown ? 'justify-end bg-accent' : 'justify-start bg-border-default',
                  )}
                >
                  <span className="h-3 w-3 rounded-full bg-card" />
                </span>
                <span className="truncate">{f.displayName}</span>
              </DropdownMenuItem>
            );
          })}
          {list.length === 0 && <p className="px-2 py-1.5 text-[12px] text-faint">No fields.</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
