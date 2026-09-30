'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  ChevronDown,
  ChevronRight,
  GripVertical,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelRight,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useDatabases, useSpaces, useWorkspace } from '@/lib/queries';
import { EntityIcon } from '@/components/ui/icon-picker';
import { DbColorMarker } from '@/components/table-view/relation-cell';
import { atLeast } from '@/lib/access';
import {
  useDatabase,
  useMembers,
  useRecordMutations,
  useUpdateDescriptionPlacement,
} from '@/components/table-view/use-table-data';
import type { Field } from '@/components/table-view/use-table-data';
import { DescriptionEditor } from '@/components/entity/description-editor';
import {
  CollapseToggle,
  CollapsibleBody,
  useCollapsedSection,
} from '@/components/entity/collapsible-section';
import { AboutPanel, ActivityPanel, AttachmentsStrip, CommentsPanel, useWatchers } from '@/components/entity/panels';
import { Segmented } from '@/components/ui/segmented';
import {
  AUDIT_TYPES,
  HIDDEN,
  fieldGroup,
  hasOwnRecordOrder,
  isCollection,
  isHidden,
  orderKey,
  resetOrderPlan,
  zonesOf,
} from '@/components/entity/entity-field-utils';
import type { FieldGroup, Zone } from '@/components/entity/entity-field-utils';
import { FieldPicker, TopStripAdd, useSetFieldConfig } from '@/components/entity/field-controls';
import { BodyScalar, ScalarValue, SidebarField, TopChip, UnifiedFieldRow } from '@/components/entity/scalar-fields';
import { CollectionSection } from '@/components/entity/collection-section';
import { RichTextFieldSection } from '@/components/entity/rich-text-field';
import {
  AddFieldRow,
  CopyLinkButton,
  FieldsPopover,
  HEADER_ICON_BTN,
  HiddenFieldRow,
  RecordActions,
  StarButton,
  WatchButton,
} from '@/components/entity/record-chrome';
import { parseRecordParam } from '@/lib/records';
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_BODY_W,
  SIDEBAR_MIN_W,
  SIDEBAR_STEP,
  useRecordSidebarWidth,
} from '@/lib/record-sidebar-width';
import { cn } from '@/lib/utils';
import { DragPreview, useDragPresentation, vacatedSlotClass } from '@/components/ui/drag-presentation';
import type { RecordRow } from '@/components/table-view/use-table-data';

/**
 * The full record body — title, pinned strip, body fields (collections + rich
 * text + scalars), description, attachments, discussion, and the properties
 * sidebar — extracted from the record-page route (#146, plan §3.1) so it renders
 * identically in BOTH the full page (`app/w/[ws]/d/[db]/r/[rec]/page.tsx`, a thin
 * wrapper) and a split-screen side panel. It takes `ws`/`db`/`rec` as PROPS
 * instead of reading `useParams()`, which is what lets a panel mount it for a
 * different record than the route.
 *
 * `onClose` switches the header's Close control from route-back (the page's own
 * behavior, preserved) to closing the panel (the split host's behavior).
 *
 * In a split, the host passes the SAME pane-chrome controls (#167/#182) to every
 * pane — the primary AND each panel: `onCollapse` docks it to its rail, and
 * `onToggleMaximize` flips between the shared ~50/50 pair and filling the split
 * area (`isMaximized` picks the Maximize/Minimize icon + label). They're absent on
 * the full page. `onClose` is passed to panels (dismiss the panel) but not to the
 * primary pane, whose Close stays route-back — the primary can't be removed from
 * the split (dock it via its rail instead).
 */
/**
 * The one record fetch, shared. Extracted for #325: the split-screen host needs
 * the primary record's TITLE for its collapsed rail spine, and the rail used to
 * hard-code the literal "Record" because it had no way to reach it. Two
 * consumers of the same query key deduplicate to a single request, so the rail
 * reads whatever `RecordDetail` already loaded rather than fetching again.
 */
export function useRecordQuery(ws: string, db: string, rec: string) {
  return useQuery({
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
}

export function RecordDetail({
  ws,
  db,
  rec,
  onClose,
  onCollapse,
  onToggleMaximize,
  isMaximized = false,
}: {
  ws: string;
  db: string;
  rec: string;
  onClose?: () => void;
  onCollapse?: () => void;
  onToggleMaximize?: () => void;
  isMaximized?: boolean;
}) {
  const router = useRouter();
  const workspace = useWorkspace(ws);
  const database = useDatabase(ws, db);
  // Breadcrumb context (#197): the database's parent space. Both queries are the
  // sidebar's cached lists, so this reuses them rather than fetching anew. There
  // is no dedicated space route yet, so Space renders as text, not a link.
  const databases = useDatabases(ws);
  const spaces = useSpaces(ws);
  const spaceName = useMemo(() => {
    const summary = databases.data?.find((d) => d.id === db);
    return summary ? spaces.data?.find((s) => s.id === summary.spaceId)?.name : undefined;
  }, [databases.data, spaces.data, db]);
  const { data: session } = useSession();
  const readOnly = !atLeast(database.data?.my_access, 'editor');
  const canComment = atLeast(database.data?.my_access, 'commenter');
  const schemaEditable = atLeast(database.data?.my_access, 'creator');
  // #310 — moves/hides the description BLOCK; never touches its content.
  const updateDescription = useUpdateDescriptionPlacement(ws, db);
  const { updateRecord } = useRecordMutations(ws, db);

  const record = useRecordQuery(ws, db, rec);

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
  /**
   * #780 — field zoning (which of top/sidebar/body a field renders in) is
   * hidden now, per Ievgen's ruling on this ticket: every non-body field
   * renders in ONE unified area instead of split across a top strip and a
   * separate properties sidebar. `topFields` and `sidebarFields` above are
   * UNCHANGED (still read from `zonesOf`/stored config — nothing about the
   * data model moved) and merged here for rendering only; a field whose
   * config lists BOTH zones would otherwise render twice.
   */
  const unifiedFields = useMemo(() => {
    const seen = new Set<string>();
    return byOrder([...topFields, ...sidebarFields].filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))));
  }, [topFields, sidebarFields, byOrder]);
  /**
   * #780 Rule 1/Rule 2 — real evidence from the Ten Real Records artifact
   * (M1NWWboSsyroxUqunyajSV), not invented thresholds: `report` at 2,770
   * chars on a three-field record was unreadable in a 148px-label grid row;
   * Backlog in Stages linked 45 records, pushing two OTHER fields off
   * screen. A field crossing these leaves the unified grid entirely and
   * renders as its own titled block below it instead — the grid stays
   * scannable, the outlier gets room. 180/12 are the artifact's own
   * LONG/RELBLOCK constants, not eyeballed. Note: the 6-chip inline cap
   * (a SEPARATE, smaller threshold — the artifact's own RELCAP) lives in
   * `ScalarValue` itself (scalar-fields.tsx), since it applies to every
   * relation-shaped chip list, not only ones dense enough to promote here.
   */
  const promotedProseFields = useMemo(() => {
    if (!record.data) return [];
    return unifiedFields.filter((f) => {
      const v = record.data!.values[f.apiName];
      return f.type === 'text' && typeof v === 'string' && v.length > 180;
    });
  }, [unifiedFields, record.data]);
  const promotedRelationFields = useMemo(() => {
    if (!record.data) return [];
    return unifiedFields.filter((f) => {
      const v = record.data!.values[f.apiName];
      return f.type === 'relation' && Array.isArray(v) && v.length > 12;
    });
  }, [unifiedFields, record.data]);
  const gridFields = useMemo(() => {
    const promotedIds = new Set([...promotedProseFields, ...promotedRelationFields].map((f) => f.id));
    return unifiedFields.filter((f) => !promotedIds.has(f.id));
  }, [unifiedFields, promotedProseFields, promotedRelationFields]);
  /** #780 — the artifact's own four collapsible headings, in its own order. */
  const FIELD_GROUP_ORDER: FieldGroup[] = ['Details', 'Links', 'Computed', 'System'];
  const groupedFields = useMemo(() => {
    const groups = new Map<FieldGroup, Field[]>(FIELD_GROUP_ORDER.map((g) => [g, []]));
    for (const f of gridFields) groups.get(fieldGroup(f))!.push(f);
    return FIELD_GROUP_ORDER.map((g) => [g, groups.get(g)!] as const).filter(([, fs]) => fs.length > 0);
  }, [gridFields]);
  /**
   * #780 — the status strip: a fixed, non-configurable summary row under the
   * title (workflow state, an assignee-shaped field, a due-date-shaped
   * field, watcher count), per the design screenshots — NOT a return of the
   * old "pin any field to top" mechanism (that's the zoning feature being
   * hidden). `workflow` is capped at one per database by the schema itself
   * (#172), so `.find` is unambiguous; assignee/due have no such first-class
   * concept in the data model, so this is a best-effort pick of the first
   * matching type among fields that would have shown near the top before —
   * flagged on the ticket as provisional, not a designed mapping.
   */
  const stripWorkflowField = visibleFields.find((f) => f.type === 'workflow');
  const stripAssigneeField = unifiedFields.find((f) => f.type === 'user');
  const stripDueField = unifiedFields.find((f) => f.type === 'date');

  // #780 — one useCollapsedSection call per POSSIBLE group, fixed at 4 and
  // unconditional (never inside groupedFields' own .map, which varies in
  // length per record) — hooks can't be called a variable number of times;
  // same reasoning as the file's own comment above propDrag about hook order.
  const detailsSection = useCollapsedSection(db, 'field-group-details');
  const linksSection = useCollapsedSection(db, 'field-group-links');
  const computedSection = useCollapsedSection(db, 'field-group-computed');
  const systemSection = useCollapsedSection(db, 'field-group-system');
  const groupSection: Record<FieldGroup, ReturnType<typeof useCollapsedSection>> = {
    Details: detailsSection,
    Links: linksSection,
    Computed: computedSection,
    System: systemSection,
  };
  /**
   * #310 — the description joins the body ordering model.
   *
   * It is NOT a field (it's a versioned `documents` row), so it has no field config
   * to carry entity_order. Its position and visibility live on the DATABASE, and it
   * takes part here as a virtual item so one drag reorders fields and the
   * description together, in a single integer space.
   */
  const descriptionHidden = database.data?.descriptionHidden === true;
  const descriptionOrder = database.data?.descriptionOrder;
  const bodyItems = useMemo(() => {
    const items: Array<{ id: string; field?: Field }> = bodyFields.map((f) => ({ id: f.id, field: f }));
    if (descriptionHidden) return items;
    // null order = the historical position: after every body field.
    const at = descriptionOrder == null ? items.length : Math.max(0, Math.min(items.length, descriptionOrder));
    items.splice(at, 0, { id: DESCRIPTION_ITEM_ID });
    return items;
  }, [bodyFields, descriptionHidden, descriptionOrder]);

  // #301: the rows that actually participate in the drag. Everything in the body is
  // sortable when the schema is editable; nothing is when it isn't. Renumbering must
  // run over THIS list, or a drop would rewrite entity_order for rows the user can't
  // move and the persisted order wouldn't match the order the drag previewed.
  const sortableBodyIds = useMemo(
    () => (schemaEditable ? bodyItems.map((i) => i.id) : []),
    [schemaEditable, bodyItems],
  );
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

  /**
   * #310 — reorder a body list that mixes fields with the description block. One
   * integer space: each item's new index is persisted to its own home — a field's to
   * its `entity_order` field-config, the description's to the database's
   * `description_order`.
   */
  function reorderBody(items: Array<{ id: string; field?: Field }>, event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = items.findIndex((i) => i.id === event.active.id);
    const to = items.findIndex((i) => i.id === event.over!.id);
    if (from < 0 || to < 0) return;
    arrayMove(items, from, to).forEach((item, i) => {
      if (item.id === DESCRIPTION_ITEM_ID) {
        if (database.data?.descriptionOrder !== i) updateDescription.mutate({ description_order: i });
        return;
      }
      const f = item.field!;
      if (orderKey(f, apiIndex.get(f.id) ?? 0) !== i) {
        setFieldConfig.mutate({ fieldId: f.id, config: { entity_order: i } });
      }
    });
  }

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
  /**
   * "Follow the database order" (#414 AC2) — the way back out of the one-way door.
   *
   * Clears `entity_order` on every field that carries one and returns the
   * description to its unset position, after which `orderKey` falls back to the
   * field's API position and the properties panel matches the grid again.
   *
   * One mutation per field rather than a bulk endpoint: the same
   * `setFieldConfig` path the drags already use, so there is no second way to
   * write this config that could drift from the first. A database with enough
   * fields for that to be slow has a bigger problem than this button.
   */
  function followDatabaseOrder() {
    const plan = resetOrderPlan(allFields, descriptionOrder);
    for (const fieldId of plan.fieldIds) setFieldConfig.mutate({ fieldId, config: { entity_order: null } });
    if (plan.clearDescription) updateDescription.mutate({ description_order: null });
  }

  /** Toggle a field's presence in a zone (MN-077). Unchecking the last zone hides the field. */
  const toggleZone = (field: Field, zone: Zone) => {
    const cur = zonesOf(field);
    const next = cur.includes(zone) ? cur.filter((z) => z !== zone) : [...cur, zone];
    if (next.length === 0) setFieldConfig.mutate({ fieldId: field.id, config: { entity_hidden: true } });
    else setFieldConfig.mutate({ fieldId: field.id, config: { entity_zones: next, entity_hidden: false } });
  };

  // #740 AC2 — three tabs (Activity/Comments/About), per Ievgen's answer to the
  // "Contents" ambiguity: it was never a fourth tab, it was "About" garbled.
  const [tab, setTab] = useState<'activity' | 'comments' | 'about'>('activity');
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  /** #780 Rule 1 — which promoted prose blocks are expanded past their clip. */
  const [expandedProse, setExpandedProse] = useState<Set<string>>(new Set());
  /**
   * #780 — Ievgen's ruling: the side panel is collapsible by the user, open
   * by default on the full record page, and auto-collapsed on mount when
   * opened as a split-screen panel (a halved viewport shouldn't also lose
   * 344px to a panel nobody asked to see). `onClose` is passed ONLY for the
   * split-panel case (see this component's own prop doc above) — the same
   * signal already used to distinguish "Close dismisses the panel" from
   * "Close navigates back" — so it doubles as the panel-vs-primary check
   * here rather than inventing a second one. Lazy initializer: this only
   * needs to run once at mount, matching "auto-collapse on open", not on
   * every render.
   *
   * Simple version, not persisted across remounts or sessions — a manual
   * expand "sticks" only as long as this component instance stays mounted.
   * Otto's own note allowed this: "if that's awkward given how split-
   * screen-host mounts, do the simple version and note it on #780." Doing
   * that: `RecordSurface`/the panel host key records by id, so navigating to
   * a DIFFERENT record in the same panel does NOT remount this component in
   * every case, which means the simple version mostly holds already; a full
   * page reload resets it, which is the one gap.
   */
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(() => Boolean(onClose));
  // #312 — retire the title draft only once the saved value has actually arrived, so
  // the input never falls back to a stale title mid-save. If the save fails the draft
  // stays, which is the right outcome: the user keeps what they typed.
  const serverTitle = record.data?.title;
  useEffect(() => {
    if (titleDraft !== null && serverTitle === titleDraft) setTitleDraft(null);
  }, [serverTitle, titleDraft]);

  // Resizable properties sidebar (#198). `columnsRef` measures the body+aside
  // flex row so the drag/keyboard math can keep the body from getting too
  // narrow. Width applies only at lg+ (see the inline style + ResizeHandle).
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const { width: sidebarWidth, setWidth: setSidebarWidth, persist: persistSidebarWidth } =
    useRecordSidebarWidth();

  /*
   * #409/#412/#415 — one presentation for all three property zones (top chips,
   * body, sidebar). Only one drag runs at a time, so a single hook serves them;
   * `label` resolves a field id to its display name, which is what #415 needs —
   * these lists are keyed by field uuid, so the stock announcements were hex.
   *
   * ABOVE the early returns below, and it must stay there. #412 landed it after
   * them, which meant this component called 110 hooks while the record was
   * loading and 111 once it arrived — "Rendered more hooks than during the
   * previous render", and every record page was a blank error boundary on main.
   * Any hook added to RecordDetail belongs in this block, not further down.
   */
  const fieldLabel = (id: string) => visibleFields.find((f) => f.id === id)?.displayName;
  const propDrag = useDragPresentation(fieldLabel);

  // #780 — same rule as propDrag above: hooks belong here, not after the
  // early returns. Regression fix: the watchers endpoint does NOT accept a
  // pretty slug the way useRecordQuery does — it 500s on every poll when
  // `rec` (the raw route param) is one. `record.data?.id` is the resolved
  // uuid, available here as soon as the fetch above completes even though we
  // are still ahead of the early-return guards; `useWatchers`'s `enabled`
  // guard keeps this from firing at all until that id exists.
  const watchers = useWatchers(ws, db, record.data?.id ?? '');

  if (record.isLoading || database.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (!record.data) return <p className="p-6 text-sm text-error">Item not found.</p>;

  // The route param can be a pretty `slug-{number}` (MN-087); every child + mutation
  // must use the resolved UUID, never the raw param.
  const recordId = record.data.id;

  // MN-131: when the title field is in `computed` mode (#130) the name is derived
  // from a template and materialized server-side — it must be read-only here.
  const titleComputed =
    ((database.data?.fields ?? []).find((f) => f.type === 'title')?.config as { name_mode?: string } | undefined)
      ?.name_mode === 'computed';
  const titleReadOnly = readOnly || titleComputed;

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
    <div className="flex h-full min-h-0 flex-col">
      {/* #780 — top chrome: 47px tall (9px/14px padding), 1px bottom border,
          never scrolls — measured from the design artifact (BhswniXwukzMpZE4kW9iJs)
          at 1270px. Was page padding with no border/height of its own. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-default px-3.5 py-[9px]">
        {/* Breadcrumb (#197): Space › Database › #id. Database links to its list
            view and carries the db colour/icon; Space is text-only (no dedicated
            space route yet). Route-back is preserved by the Close control. */}
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-0.5 text-body text-muted"
        >
          {spaceName && (
            <>
              <span className="hidden max-w-[9rem] truncate sm:inline" title={spaceName}>
                {spaceName}
              </span>
              {/* #706 — the breadcrumb chevrons KEEP faint: aria-hidden separators
                  with no text, judged as non-text graphics at 3:1, which faint clears. */}
              <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-faint sm:inline" aria-hidden />
            </>
          )}
          <Link
            href={`/w/${ws}/d/${db}`}
            className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover hover:text-ink"
          >
            <EntityIcon
              icon={database.data?.icon ?? null}
              color={database.data?.color ?? null}
              fallback={<DbColorMarker color={database.data?.color ?? 'gray'} />}
            />
            <span className="truncate">{database.data?.name}</span>
          </Link>
          {record.data.number !== null && (
            <>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
              <span className="shrink-0 tabular-nums text-muted" title="Public id">
                #{record.data.number}
              </span>
            </>
          )}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <StarButton ws={ws} rec={recordId} />
          {/* #780 — promoted to a header icon, matching the design artifact's
              cluster (star/watch/copy-link/split-view/delegate/actions). Reuses
              the same fetch/mutation the About tab's watcher list already used. */}
          <WatchButton ws={ws} db={db} rec={recordId} />
          {schemaEditable && <FieldsPopover ws={ws} db={db} fields={allFields} />}
          <RecordActions
            ws={ws}
            db={db}
            dbName={database.data?.name ?? ''}
            rec={recordId}
            recTitle={record.data?.title}
            recNumber={record.data?.number}
            fields={allFields}
            readOnly={readOnly}
            canCreate={schemaEditable}
            isAdmin={workspace.data?.role === 'admin'}
          />
          {/* #780 — Ievgen's ruling: collapsible by the user, open by default
              on the full page, auto-collapsed on mount in split view (see
              sidePanelCollapsed's own lazy init above). Placement is Dara's
              explicit call, not measured off any artifact (the artifact draws
              no collapse control at all — a genuine addition): beside
              split-view rather than an edge handle on the panel itself,
              because split-view is the only OTHER header control that
              changes layout rather than acting on content, and an edge
              handle would imply a drag this panel doesn't support (the
              sidebar's own resizable-edge convention would train the wrong
              expectation here). */}
          <button
            type="button"
            title={sidePanelCollapsed ? 'Show panel' : 'Hide panel'}
            aria-label={sidePanelCollapsed ? 'Show the Activity/Comments/About panel' : 'Hide the Activity/Comments/About panel'}
            className={HEADER_ICON_BTN}
            onClick={() => setSidePanelCollapsed((c) => !c)}
          >
            <PanelRight className={cn('h-4 w-4', !sidePanelCollapsed && 'text-[var(--accent)]')} />
          </button>
          {/* Split-panel chrome (#167): collapse to a peek-rail, and maximize /
              restore the split area. Only present when the host mounts this record
              as a panel. */}
          {onCollapse && (
            <button
              type="button"
              title="Collapse"
              aria-label="Collapse to rail"
              className={HEADER_ICON_BTN}
              onClick={onCollapse}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
          {onToggleMaximize && (
            <button
              type="button"
              title={isMaximized ? 'Restore' : 'Maximize'}
              aria-label={isMaximized ? 'Restore split view' : 'Maximize pane'}
              className={HEADER_ICON_BTN}
              onClick={onToggleMaximize}
            >
              {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          )}
          <button
            type="button"
            title="Close"
            aria-label="Close"
            className={HEADER_ICON_BTN}
            onClick={() => {
              // In a split panel, Close dismisses the panel (#146). On the full
              // page, return to wherever they came from; fall back to the database
              // view for deep links / fresh tabs with no in-app history.
              if (onClose) onClose();
              else if (typeof window !== 'undefined' && window.history.length > 1) router.back();
              else router.push(`/w/${ws}/d/${db}`);
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* #780 — three independent regions per the design artifact: top chrome
          (above, never scrolls), MAIN (own scroll) and the fixed 344px SIDE
          panel (own scroll, hidden below 900px total width — the artifact's
          own breakpoint, distinct from Tailwind's 1024px `lg:`). This is a
          genuine architectural change from the single-shared-scroller the
          rest of the app uses (MN-117: "main must be the scroll container") —
          the outer app shell's own <main> still wraps this route like every
          other, but this component now fills it (`h-full` above) and owns
          its OWN two scrollers instead of relying on the shell's scroll.
          Verified live: the shell's own scroll never activates because this
          subtree never overflows it, so this isn't the "two nested
          scrollers" failure #462 fixed — that was two scrollers BOTH trying
          to scroll the SAME content; here exactly one of the three regions
          scrolls at a time, by design. */}
      <div className="flex min-h-0 flex-1">
        {/* MAIN: title, status strip, unified fields, collections + rich
            sections, description, attachments. Its own scroll region. */}
        <div className="min-w-0 flex-1 overflow-y-auto px-[26px] pb-[60px] pt-[22px]" style={{ minWidth: SIDEBAR_MIN_BODY_W }}>
          <div className="mb-4 flex items-center gap-2">
            {/* #675 — this placeholder STAYS faint, and it is measured rather than
                a taste call. At text-2xl (24px) it is WCAG LARGE TEXT (>=24px), so the bar is
                3:1, not 4.5 — and this input is bg-transparent over --bg-app,
                where --text-faint measures 3.22:1 in light and 4.24:1 in dark
                (measured live, both themes). It already passes.

                Which leaves the design question, and it points the same way: the
                "Untitled" ghost is not an instruction, it is the ABSENCE of a
                title. Darkening it would make an untitled record look like one
                actually titled "Untitled" — trading a passing ratio for a worse
                product. The placeholder->muted rule (#637) is about instructions
                at body size; it is not about every string in a placeholder. */}
            <input
              className="w-full truncate bg-transparent text-2xl font-semibold text-ink outline-none placeholder:text-faint read-only:cursor-default"
              placeholder="Untitled"
              value={titleDraft ?? record.data.title}
              readOnly={titleReadOnly}
              title={titleComputed ? 'This name is computed from a template — edit the template in the Name field’s settings.' : undefined}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                // #312: don't drop the draft here when it differs — `value` is
                // `titleDraft ?? record.data.title`, so clearing it synchronously
                // snaps the input back to the STALE title until the save's refetch
                // lands, i.e. your new title visibly reverts and then re-applies.
                // The effect below clears it once the server agrees.
                if (titleDraft !== null && titleDraft !== record.data!.title) {
                  updateRecord.mutate({ rec: recordId, values: { name: titleDraft } });
                  return;
                }
                setTitleDraft(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            {titleComputed && (
              <span
                className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-meta text-muted"
                title="This name is computed from a template — edit the template in the Name field’s settings."
              >
                Computed
              </span>
            )}
            {/* One-click share (#197): always visible next to the title, copies the
                same record URL as the … menu's Copy link. */}
            <CopyLinkButton ws={ws} db={db} rec={record.data ?? { id: recordId }} />
          </div>

          {/* #780 — field zoning's own UI (pin-to-top strip + drag-reorder) is
              HIDDEN, not deleted, per Ievgen's ruling on this ticket: the
              feature, its stored config (entity_zones/entity_order) and this
              code all stay exactly as they are; SHOW_LEGACY_ZONING_UI is the
              literal "conditional that always evaluates false" this ticket's
              own thread asked for when no feature-flag system already covers
              this case. Flip it back to re-enable; nothing here was removed. */}
          {SHOW_LEGACY_ZONING_UI && (topFields.length > 0 || schemaEditable) && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              {...propDrag.contextProps}
              onDragEnd={(e) => { reorderWithin(topFields, e); propDrag.contextProps.onDragEnd(e); }}
            >
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

          {/* #780 — status strip: workflow state + best-effort assignee/due +
              watcher count, per the design screenshots. Hangs under the
              TITLE (same left inset as the title text, not the icon —
              matches the artifact's own `margin-left` offset), not a return
              of field-zoning's pin-to-top mechanism. */}
          {(stripWorkflowField || stripAssigneeField || stripDueField || (watchers.query.data?.watchers.length ?? 0) > 0) && (
            <div className="mb-5 ml-[43px] flex flex-wrap items-center gap-1.5">
              {stripWorkflowField && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-hover px-2.5 py-1 text-label font-medium text-ink">
                  <ScalarValue field={stripWorkflowField} {...vp} />
                </span>
              )}
              {stripAssigneeField && (
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-hover px-2 py-1 text-label text-ink-secondary">
                  <ScalarValue field={stripAssigneeField} {...vp} />
                </span>
              )}
              {stripDueField && (
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-hover px-2 py-1 text-label text-ink-secondary">
                  <ScalarValue field={stripDueField} {...vp} />
                </span>
              )}
              {(watchers.query.data?.watchers.length ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] px-2 py-1 text-label text-muted">
                  {watchers.query.data!.watchers.length} watching
                </span>
              )}
            </div>
          )}

          {/* #780 — the unified field area: every field that was in a top or
              sidebar zone renders here now, grouped Details/Links/Computed/
              System per the design artifact's own grouping. Body fields
              (collections, rich text) are unaffected — see the DndContext
              below, unchanged. No drag handle here: reordering within these
              groups is flagged on the ticket as a separate, un-ruled-on
              question, not assumed to survive the zoning-UI hide. */}
          {groupedFields.map(([group, fields]) => (
            <div key={group} className="mb-1.5">
              <button
                type="button"
                onClick={groupSection[group].toggle}
                className="flex h-6.5 w-full items-center gap-1.5 text-micro font-medium uppercase tracking-wider text-muted hover:text-ink-secondary"
              >
                <ChevronRight
                  className={cn('h-3 w-3 shrink-0 transition-transform', !groupSection[group].collapsed && 'rotate-90')}
                  aria-hidden
                />
                {group}
                <span className="h-px flex-1 bg-border-default" aria-hidden />
              </button>
              <CollapsibleBody collapsed={groupSection[group].collapsed}>
                <div className="flex flex-col">
                  {fields.map((field) => (
                    <UnifiedFieldRow key={field.id} field={field} {...vp} />
                  ))}
                </div>
              </CollapsibleBody>
            </div>
          ))}
          {schemaEditable && (
            <div className="mb-1.5">
              <AddFieldRow ws={ws} db={db} />
            </div>
          )}
          {/* #780 — provisional home for two controls that only lived inside
              the now-hidden Properties aside: the hidden-fields list and the
              #414 "two orders" banner. Flagged on the ticket for Dara to give
              a real placement; this keeps them reachable rather than gone. */}
          {schemaEditable && hasOwnRecordOrder(allFields, descriptionOrder) && (
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted">
              <span>Arranged for items, so it no longer follows the database order.</span>
              <button
                type="button"
                onClick={followDatabaseOrder}
                disabled={setFieldConfig.isPending}
                className="font-medium text-accent underline underline-offset-2 disabled:opacity-50"
              >
                Follow the database order
              </button>
            </div>
          )}
          {schemaEditable && (hiddenFields.length > 0 || descriptionHidden) && (
            <div className="mb-1.5">
              <button
                className="flex items-center gap-1 text-label text-muted hover:text-ink"
                onClick={() => setShowHidden((s) => !s)}
              >
                {showHidden ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {hiddenFields.length + (descriptionHidden ? 1 : 0)} hidden
              </button>
              {showHidden && (
                <>
                  {descriptionHidden && (
                    <div className="flex items-center justify-between py-1 text-body text-muted">
                      <span>Description</span>
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-label text-info hover:bg-hover"
                        onClick={() => updateDescription.mutate({ description_hidden: false })}
                      >
                        Show
                      </button>
                    </div>
                  )}
                  {hiddenFields.map((field) => (
                    <HiddenFieldRow key={field.id} ws={ws} db={db} field={field} />
                  ))}
                </>
              )}
            </div>
          )}

          {/* #780 Rule 2 — a relation field with more than 12 links leaves the
              grid and becomes its own titled block with a count, per the Ten
              Real Records artifact (Backlog in Stages: 45 links). Still capped
              at 6 inline chips + "+N more" (ScalarValue's own cap), same as
              every relation chip list — this block only changes WHERE it
              renders, not how the chips themselves render. */}
          {promotedRelationFields.map((field) => {
            const count = Array.isArray(record.data!.values[field.apiName])
              ? (record.data!.values[field.apiName] as unknown[]).length
              : 0;
            return (
              <div key={field.id} className="mt-6">
                <div className="mb-1.5 flex items-center gap-2">
                  <h4 className="text-body font-semibold text-ink">{field.displayName}</h4>
                  <span className="rounded border border-border-default px-1 font-mono text-micro text-muted">
                    {count} linked
                  </span>
                </div>
                <ScalarValue field={field} {...vp} />
              </div>
            );
          })}

          {/* #780 Rule 1 — a text field over 180 characters leaves the grid
              and becomes a titled prose block, clipped with "Show all", per
              the Ten Real Records artifact (a real incident `report` field
              ran 2,770 characters on a three-field record — unreadable in a
              148px-label grid row). The common case, not the exception: five
              of the artifact's ten sampled records had a field long enough
              to trigger this. */}
          {promotedProseFields.map((field) => {
            const text = String(record.data!.values[field.apiName] ?? '');
            const expanded = expandedProse.has(field.id);
            return (
              <div key={field.id} className="mt-6 max-w-[74ch]">
                <div className="mb-1.5 flex items-center gap-2">
                  <h4 className="text-body font-semibold text-ink">{field.displayName}</h4>
                  <span className="rounded border border-border-default px-1 font-mono text-micro text-muted">
                    {text.length.toLocaleString()} chars
                  </span>
                </div>
                <div
                  className={cn(
                    'relative whitespace-pre-wrap border-l-2 border-border-default pl-3.5 text-body leading-relaxed text-ink-secondary',
                    !expanded && 'max-h-[172px] overflow-hidden',
                  )}
                >
                  {text}
                  {!expanded && (
                    <span
                      aria-hidden
                      className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--bg-app)] to-transparent"
                    />
                  )}
                </div>
                <button
                  type="button"
                  className="mt-1 rounded px-1 text-label font-medium text-muted hover:bg-hover hover:text-ink"
                  onClick={() =>
                    setExpandedProse((prev) => {
                      const next = new Set(prev);
                      if (next.has(field.id)) next.delete(field.id);
                      else next.add(field.id);
                      return next;
                    })
                  }
                >
                  {expanded ? 'Show less' : 'Show all'}
                </button>
              </div>
            );
          })}

          {/* Body fields: collections (lists), scalars-in-body, rich text — in order.
              All are drag-reorderable via a hover-revealed handle EXCEPT rich-text
              sections, which stay put (founder's call): scalar/collection fields
              reorder around the fixed rich-text blocks. Every field is in the
              SortableContext, but rich-text rows are marked non-sortable so they
              are neither draggable nor a drop target. */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            {...propDrag.contextProps}
            onDragEnd={(e) => { reorderBody(bodyItems, e); propDrag.contextProps.onDragEnd(e); }}
          >
            {/* #301: a row that isn't sortable must be OUT of this list, not merely
                `disabled`. dnd-kit still lays out and transforms a disabled member,
                which is what made a tall rich-text card slide over its neighbours
                mid-drag and read as one field nested inside another. */}
            <SortableContext items={sortableBodyIds} strategy={verticalListSortingStrategy}>
              {bodyItems.map((item) => {
                // #310 — the description block sorts alongside the fields.
                if (!item.field) {
                  return (
                    <BodyRow key={item.id} rowId={item.id} draggable={schemaEditable}>
                      <DescriptionSection
                        ws={ws}
                        db={db}
                        recordId={recordId}
                        readOnly={readOnly}
                        onHide={
                          schemaEditable
                            ? () => updateDescription.mutate({ description_hidden: true })
                            : undefined
                        }
                      />
                    </BodyRow>
                  );
                }
                const field = item.field;
                // #301: rich-text was draggable={false}, which froze Details /
                // Acceptance Criteria / User Story — exactly the rows a long record
                // most needs moved. Practical now that #309 can collapse them.
                return field.type === 'rich_text' ? (
                  <BodyRow key={field.id} rowId={field.id} draggable={schemaEditable}>
                    <RichTextFieldSection
                      ws={ws}
                      db={db}
                      field={field}
                      value={record.data.values[field.apiName]}
                      readOnly={readOnly}
                      schemaEditable={schemaEditable}
                      onToggleZone={toggleZone}
                      onCommit={(value) => updateRecord.mutate({ rec: recordId, values: { [field.apiName]: value } })}
                    />
                  </BodyRow>
                ) : field.type === 'relation' ? (
                  <BodyRow key={field.id} rowId={field.id} draggable={schemaEditable}>
                    <CollectionSection field={field} {...vp} />
                  </BodyRow>
                ) : (
                  <BodyRow key={field.id} rowId={field.id} draggable={schemaEditable}>
                    <BodyScalar field={field} {...vp} />
                  </BodyRow>
                );
              })}
            </SortableContext>
            <DragPreview>
              {propDrag.activeId && (
                <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1 text-body text-ink shadow-[var(--shadow-lifted)]">
                  {fieldLabel(propDrag.activeId) ?? ''}
                </div>
              )}
            </DragPreview>
          </DndContext>

          {/* #740 AC1 — no longer a default block; own margin lives inside
              AttachmentsStrip now, since it renders nothing (no wrapper div,
              no blank space) for a database with no attachment field and no
              pre-existing attachments on this record. */}
          <AttachmentsStrip
            ws={ws}
            db={db}
            rec={recordId}
            readOnly={readOnly}
            hasAttachmentField={allFields.some((f) => f.type === 'attachment')}
          />
        </div>

        {/* #780 — SIDE: fixed 344px, never flexes, hidden entirely below a
            900px TOTAL width (the artifact's own breakpoint — deliberately
            not Tailwind's 1024px `lg:`, which is what the app's other
            two-column layouts use; this one page follows the design's own
            number instead). Own scroll region; the tab bar is pinned above
            it (outside `.side-scroll` in the artifact), so switching tabs
            never requires scrolling back up. Activity/Comments/About moved
            here from the bottom of MAIN — same three panels, same content,
            just relocated per the design. */}
        {!sidePanelCollapsed && (
        <aside className="hidden w-[344px] shrink-0 flex-col border-l border-border-default min-[900px]:flex">
          <div className="shrink-0 px-2 pt-[7px]">
            <Segmented
              label="Item panel"
              options={[
                { value: 'activity', label: 'Activity' },
                { value: 'comments', label: 'Comments' },
                { value: 'about', label: 'About' },
              ]}
              value={tab}
              onChange={setTab}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
            {tab === 'activity' ? (
              <ActivityPanel ws={ws} db={db} rec={recordId} />
            ) : tab === 'comments' ? (
              !canComment ? (
                <p className="text-body text-muted">You can view this item but not comment on it.</p>
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
              <AboutPanel
                ws={ws}
                db={db}
                rec={recordId}
                members={memberList}
                databaseName={database.data?.name ?? ''}
                spaceName={spaceName}
                recordNumber={record.data.number}
                createdAt={record.data.created_at}
                updatedAt={record.data.updated_at}
                myAccess={database.data?.my_access}
              />
            )}
          </div>
        </aside>
        )}

        {/* #780 — the OLD resizable Properties sidebar: HIDDEN, not deleted,
            same SHOW_LEGACY_ZONING_UI flag as the top-strip block above.
            Scalar fields that used to render here now render in the unified
            field area in MAIN instead (see groupedFields above). */}
        {SHOW_LEGACY_ZONING_UI && (
        <>
        <ResizeHandle
          width={sidebarWidth}
          containerRef={columnsRef}
          onResize={setSidebarWidth}
          onCommit={persistSidebarWidth}
        />
        <aside
          style={{ '--rec-sidebar-w': `${sidebarWidth}px` } as CSSProperties}
          className="w-full shrink-0 lg:sticky lg:top-6 lg:w-[var(--rec-sidebar-w)]"
        >
          <div className="rounded-[var(--radius-card)] border border-border-default bg-card">
            <div className="flex items-center justify-between border-b border-border-default px-3 py-2">
              <span className="text-meta font-semibold uppercase tracking-wider text-muted">Properties</span>
              {schemaEditable && (
                <FieldPicker
                  label="Add a property"
                  candidates={visibleFields.filter((f) => !zonesOf(f).includes('sidebar') && !isCollection(f) && f.type !== 'rich_text')}
                  onPick={(f) => toggleZone(f, 'sidebar')}
                />
              )}
            </div>
            {/* #414 — two orders are fine; two orders that LOOK like one are not.
                Shown only when this database actually has its own arrangement, so
                the default case stays quiet. */}
            {schemaEditable && hasOwnRecordOrder(allFields, descriptionOrder) && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-default px-3 py-2 text-meta text-muted">
                <span>Arranged for items, so it no longer follows the database order.</span>
                <button
                  type="button"
                  onClick={followDatabaseOrder}
                  disabled={setFieldConfig.isPending}
                  className="font-medium text-accent underline underline-offset-2 disabled:opacity-50"
                >
                  Follow the database order
                </button>
              </div>
            )}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              {...propDrag.contextProps}
              onDragEnd={(e) => { reorderWithin(sidebarFields, e); propDrag.contextProps.onDragEnd(e); }}
            >
              <SortableContext items={sidebarFields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-0.5 p-1.5">
                  {sidebarFields.length === 0 && (
                    <p className="px-1.5 py-2 text-label text-muted">No sidebar properties.</p>
                  )}
                  {/* #179: mark the first system/audit field that trails a user
                      field so SidebarField can draw a subtle group divider. */}
                  {(() => {
                    const dividerId = sidebarFields.find(
                      (f, i) => AUDIT_TYPES.has(f.type) && i > 0 && !AUDIT_TYPES.has(sidebarFields[i - 1]!.type),
                    )?.id;
                    return sidebarFields.map((field) => (
                      <SidebarField key={field.id} field={field} topDivider={field.id === dividerId} {...vp} />
                    ));
                  })()}
                </div>
              </SortableContext>
            </DndContext>

            {schemaEditable && (hiddenFields.length > 0 || descriptionHidden) && (
              <div className="border-t border-border-default px-3 py-1.5">
                <button
                  className="flex items-center gap-1 text-label text-muted hover:text-ink"
                  onClick={() => setShowHidden((s) => !s)}
                >
                  {showHidden ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {hiddenFields.length + (descriptionHidden ? 1 : 0)} hidden
                </button>
                {showHidden && (
                  <>
                    {/* #310 — hiding the description must not be a one-way door: it
                        comes back from the same place every hidden field does. Its
                        CONTENT was never deleted, only the block. */}
                    {descriptionHidden && (
                      <div className="flex items-center justify-between py-1 text-body text-muted">
                        <span>Description</span>
                        <button
                          type="button"
                          className="rounded px-1.5 py-0.5 text-label text-info hover:bg-hover"
                          onClick={() => updateDescription.mutate({ description_hidden: false })}
                        >
                          Show
                        </button>
                      </div>
                    )}
                    {hiddenFields.map((field) => (
                      <HiddenFieldRow key={field.id} ws={ws} db={db} field={field} />
                    ))}
                  </>
                )}
              </div>
            )}
            {schemaEditable && (
              <div className="border-t border-border-default px-3 py-1.5">
                <AddFieldRow ws={ws} db={db} />
              </div>
            )}
          </div>
        </aside>
        </>
        )}
      </div>
    </div>
  );
}

/** #780 — field zoning's own dedicated UI (pin-to-top strip, the resizable
 * Properties aside) is hidden pending a real placement decision from Dara
 * for what remains (hidden-fields list, "Add a property", database-order
 * banner), per Ievgen's ruling: hide the UI, keep the code and the stored
 * config exactly as they are. This is the literal smallest mechanism that
 * stops it rendering, since no feature-flag system already covers this. */
const SHOW_LEGACY_ZONING_UI = false;

/**
 * Sortable wrapper for a body field. Reorder is driven by a hover-revealed grab
 * handle only (never the row body) so field content/editing is never disturbed.
 * `draggable={false}` (rich-text sections) marks the row non-sortable — no handle,
 * and it is neither draggable nor a drop target, so other rows reorder around it.
 */
/** #310 — the virtual sortable id for the description block (it has no field id). */
const DESCRIPTION_ITEM_ID = '__description__';

function BodyRow({
  rowId,
  draggable,
  children,
}: {
  /** #310 — a field id, or the virtual description id; BodyRow no longer needs the Field. */
  rowId: string;
  draggable: boolean;
  children: ReactNode;
}) {
  const sortable = useSortable({ id: rowId, disabled: !draggable });
  // #301: never transform a row that isn't participating in the sort — a stale
  // transform on a tall card is what made rows visually overlap during a drag.
  const style = draggable
    ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
    : undefined;
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      // #409 — the floating card used to print over `Owner` and `Won` on its
      // way up the panel. It now renders in the shared portalled overlay.
      className={cn('group/bodyrow relative', vacatedSlotClass(sortable.isDragging))}
    >
      {draggable && (
        <button
          type="button"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          className={cn(
            // #706 — KEEPS faint: the handle's only content is a drag glyph, a
            // non-text graphic at 3:1. Its accessible name is the aria-label.
            'absolute -left-6 top-0.5 flex h-6 w-5 touch-none items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-hover hover:text-muted group-hover/bodyrow:opacity-100 sm:-left-7',
            sortable.isDragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
          {...sortable.attributes}
          {...sortable.listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      {children}
    </div>
  );
}

/**
 * The draggable divider between the record body and the properties sidebar
 * (#198). Desktop-only (`hidden lg:block`) — a thin hairline that brightens on
 * hover/focus/drag, with a wide invisible hit area. Dragging left grows the
 * sidebar (the body takes the rest); double-click or Home resets to the 288px
 * default; ArrowLeft/ArrowRight nudge the width. Drag is pointer-event based:
 * pointerdown captures the start, window pointermove updates the live width
 * (clamped against the measured container so the body never gets too narrow),
 * and pointerup persists. `role="separator"` + arrow keys make it accessible.
 */
function ResizeHandle({
  width,
  containerRef,
  onResize,
  onCommit,
}: {
  width: number;
  containerRef: RefObject<HTMLDivElement | null>;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Keep the latest width in a ref so the window listeners (bound once) read the
  // current value without re-subscribing on every resize.
  const widthRef = useRef(width);
  widthRef.current = width;

  const containerWidth = () => containerRef.current?.getBoundingClientRect().width;

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const s = drag.current;
      if (!s) return;
      // Sidebar is on the right: dragging the handle left (smaller clientX) grows it.
      onResize(clampSidebarWidth(s.startW + (s.startX - e.clientX), containerWidth()));
    }
    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      onCommit(widthRef.current);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // containerRef is a stable ref; onResize/onCommit are stable callbacks.
  }, [containerRef, onResize, onCommit]);

  const nudge = (deltaPx: number) =>
    onCommit(clampSidebarWidth(widthRef.current + deltaPx, containerWidth()));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize properties sidebar"
      aria-valuemin={SIDEBAR_MIN_W}
      aria-valuemax={SIDEBAR_MAX_W}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { startX: e.clientX, startW: widthRef.current };
        setDragging(true);
      }}
      onDoubleClick={() => onCommit(SIDEBAR_DEFAULT_W)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          nudge(SIDEBAR_STEP); // grow the sidebar
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          nudge(-SIDEBAR_STEP); // shrink the sidebar
        } else if (e.key === 'Home') {
          e.preventDefault();
          onCommit(SIDEBAR_DEFAULT_W);
        }
      }}
      className={cn(
        'group relative hidden shrink-0 cursor-col-resize touch-none self-stretch lg:block',
        // Negative margins let the wide hit area overlap the gap-6 without adding width.
        '-mx-2 w-4',
        dragging && 'select-none',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
          dragging
            ? 'bg-accent'
            : 'bg-border-default group-hover:bg-border-strong group-focus-visible:bg-border-strong',
        )}
      />
    </div>
  );
}

/**
 * #309 — the Description block, foldable like every other rich-text section.
 *
 * Its own component only because Description is not a field: it's hard-coded into
 * the page rather than living in the body-field list, so it can't reuse
 * RichTextFieldSection. #310 tracks making it first-class; when that lands, this
 * wrapper should disappear rather than grow.
 */
function DescriptionSection({
  ws,
  db,
  recordId,
  readOnly,
  onHide,
}: {
  ws: string;
  db: string;
  recordId: string;
  readOnly: boolean;
  /** #310 — remove the description block from this DATABASE's records. Content is
   * kept (the documents row is untouched); switching it back on restores it. */
  onHide?: () => void;
}) {
  const { collapsed, toggle } = useCollapsedSection(db, 'description');
  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <CollapseToggle collapsed={collapsed} onToggle={toggle} label="Description" />
        <h2 className="text-label font-medium uppercase tracking-wider text-muted">Description</h2>
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            title="Remove Description from this database's items"
          /* #706 — KEEPS faint: this button's only content is an X icon, a
             non-text graphic judged at 3:1, which faint clears. */
            className="ml-1 rounded p-0.5 text-faint opacity-0 transition-opacity hover:bg-hover hover:text-error group-hover/bodyrow:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <CollapsibleBody collapsed={collapsed}>
        <DescriptionEditor ws={ws} db={db} rec={recordId} readOnly={readOnly} />
      </CollapsibleBody>
    </div>
  );
}
