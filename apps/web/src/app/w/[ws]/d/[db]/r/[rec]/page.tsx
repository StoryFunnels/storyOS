'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useWorkspace } from '@/lib/queries';
import { atLeast } from '@/lib/access';
import { useDatabase, useMembers, useRecordMutations } from '@/components/table-view/use-table-data';
import type { Field } from '@/components/table-view/use-table-data';
import { DescriptionEditor } from '@/components/entity/description-editor';
import { ActivityPanel, AttachmentsStrip, CommentsPanel, MentionedIn } from '@/components/entity/panels';
import {
  HIDDEN,
  isCollection,
  isHidden,
  orderKey,
  zonesOf,
} from '@/components/entity/entity-field-utils';
import type { Zone } from '@/components/entity/entity-field-utils';
import { FieldPicker, TopStripAdd, useSetFieldConfig } from '@/components/entity/field-controls';
import { BodyScalar, SidebarField, TopChip } from '@/components/entity/scalar-fields';
import { CollectionSection } from '@/components/entity/collection-section';
import { RichTextFieldSection } from '@/components/entity/rich-text-field';
import {
  AddFieldRow,
  FieldsPopover,
  HiddenFieldRow,
  RecordActions,
  StarButton,
} from '@/components/entity/record-chrome';
import { parseRecordParam } from '@/lib/records';
import { cn } from '@/lib/utils';
import type { RecordRow } from '@/components/table-view/use-table-data';

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
    <div className="px-4 py-6 sm:px-8">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/w/${ws}/d/${db}`}
            className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-muted hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{database.data?.name}</span>
          </Link>
          {record.data.number !== null && (
            <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] tabular-nums text-faint" title="Public id">
              #{record.data.number}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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

          <MentionedIn ws={ws} db={db} rec={recordId} />

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
