'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Maximize2, UserPlus } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { recordHref, recordSegment } from '@/lib/records';
import { useOpenRecord } from '@/components/entity/split-panel-context';
import { useDateFormat } from '@/lib/preferences';
import { atLeast } from '@/lib/access';
import { cn } from '@/lib/utils';
import { CommentComposer } from '../entity/panels';
import { dayBucket } from '../inbox-panel';
import { CardFieldChip, RecordNumberBadge } from './board-view';
import { CellEditor, OptionChip, richTextPreview, optionColor } from '../table-view/cells';
import { isNumberColumnHidden } from '../table-view/number-column';
import { useDatabase, useMembers, useRecordMutations, useRecordsInfinite } from '../table-view/use-table-data';
import type { Field, RecordRow } from '../table-view/use-table-data';
import type { FilterNode, ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';
import { useViewSearch } from './view-search';
import { feedActionFields } from './feed-actions';
import { EmptyState, databaseNoun } from './empty-state';
import { ViewQueryError } from './query-error';

/** Feed view (MN-093): a single-column stream of wide cards — title, a preview of
 * the record's first rich-text field, the card fields, and who/when. Built for
 * reviewing notes / feedback / updates. */
export function FeedView({
  ws,
  db,
  config,
  readOnly,
  personalFilter,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
  /** #259 — narrows this view's results for the current viewer only. */
  personalFilter?: FilterNode;
}) {
  const database = useDatabase(ws, db);
  const router = useRouter();
  // #199 — the shared split/navigate decision, identical on every surface.
  const openRecord = useOpenRecord('swap');
  const fmt = useDateFormat();
  const search = useViewSearch(db);
  const queryBody = useMemo(() => queryBodyFromConfig(config, personalFilter, search), [config, personalFilter, search]);
  const records = useRecordsInfinite(ws, db, queryBody);
  const { updateRecord, createRecord } = useRecordMutations(ws, db);

  const addRecord = () =>
    createRecord.mutate(
      { name: 'Untitled' },
      { onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`) },
    );

  // #702 — feed was found rendering `row.number` unconditionally too, the same
  // defect #701 fixed for list view: one field, opposite defaults depending on
  // which view type you're looking at. Same shared decision, not a third copy.
  const numberHidden = useMemo(() => {
    const real = (database.data?.fields ?? []).find((f) => f.apiName === 'number');
    return isNumberColumnHidden(config.hidden_field_ids, real?.id);
  }, [config.hidden_field_ids, database.data]);

  const memberQuery = useMembers(ws, !readOnly);
  const memberNames = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.name])),
    [memberQuery.data],
  );
  const memberImages = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.image])),
    [memberQuery.data],
  );
  const memberList = useMemo(
    () => (memberQuery.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name, image: m.user.image })),
    [memberQuery.data],
  );

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const richField = database.data?.fields.find((f) => f.type === 'rich_text');
  // Preserve the saved card_field_ids order (MN-151), not schema order.
  const cardFields = useMemo(
    () =>
      config.card_field_ids
        .map((id) => (database.data?.fields ?? []).find((f) => f.id === id))
        .filter((f): f is NonNullable<typeof f> => Boolean(f)),
    [database.data, config.card_field_ids],
  );
  const colorField = database.data?.fields.find((f) => f.id === config.color_by_field_id);
  /*
   * #790 (F1/F2) — the footer used to print row.created_at unconditionally,
   * regardless of what the view actually sorts by: sort by Priority and the
   * footer still shows creation dates in an order they don't explain. "The
   * date is there to explain the position; any other date is decoration
   * pretending to be an explanation."
   *
   * Resolves the ACTUAL sort field (falls back to created_at, matching the
   * server's own unsorted default) and asks whether it's chronological. Day
   * breaks (F2) are gated on this too, per the artifact's own constraint:
   * "you cannot bucket by day when the order is Priority" — so grouping only
   * ever applies when there is a real time axis to group by.
   */
  const sortField = database.data?.fields.find((f) => f.apiName === (config.sorts[0]?.field ?? 'created_at'));
  const CHRONOLOGICAL = new Set(['date', 'created_at', 'updated_at']);
  const isChronologicalSort = sortField ? CHRONOLOGICAL.has(sortField.type) : false;
  // Only ever resolves a value for an ACTUALLY chronological sort field — a
  // Priority/Name sort must fall through to plain created_at below, not print
  // "Priority" beside whatever a select option's raw id happens to parse as.
  const dateOf = (row: RecordRow): string | null => {
    if (!isChronologicalSort || !sortField) return null;
    if (sortField.type === 'created_at') return row.created_at;
    if (sortField.type === 'updated_at') return row.updated_at;
    const raw = row.values[sortField.apiName];
    return typeof raw === 'string' ? raw : null;
  };
  // Quick-actions row (#76): which select/checkbox/user field each action edits,
  // derived purely from the schema — omitted entirely when the database has none.
  const { statusField, checkboxField, userField } = useMemo(
    () => feedActionFields(database.data?.fields ?? [], config),
    [database.data, config],
  );
  const canAct = !readOnly;
  const canComment = atLeast(database.data?.my_access, 'commenter');

  if (rows.length === 0)
    return (
      <EmptyState
        noun={databaseNoun(database.data?.name)}
        onAdd={readOnly ? undefined : addRecord}
        description={database.data?.description}
      />
    );

  // #346 — a rejected query must never render as an empty view. Placed after every
  // hook so the early return cannot change hook order.
  if (records.isError) return <ViewQueryError error={records.error} onRetry={() => void records.refetch()} />;
  return (
    <div className="h-full overflow-auto">
      <div className="flex max-w-2xl flex-col gap-3 px-4 py-4">
        {rows.map((row, i) => {
          const preview = richField ? richTextPreview(row.values[richField.apiName], 280) : '';
          const author = row.created_by;
          const dot = colorField ? optionColor(colorField, row.values[colorField.apiName]) : null;
          // #790 (F2) — a day break header, only while sorted by a real
          // chronological field (a non-time sort has nothing to bucket by).
          const rowDate = dateOf(row);
          const bucket = isChronologicalSort && rowDate ? dayBucket(rowDate) : null;
          const prevDate = i > 0 ? dateOf(rows[i - 1]!) : null;
          const prevBucket = isChronologicalSort && prevDate ? dayBucket(prevDate) : null;
          const showDayBreak = bucket !== null && bucket !== prevBucket;
          return (
            <Fragment key={row.id}>
            {showDayBreak && (
              <div className="mt-2 flex items-center gap-2 px-1 text-label font-semibold text-ink first:mt-0">
                {bucket}
                <span className="h-px flex-1 bg-border-default" />
              </div>
            )}
            <div
              onClick={(e) =>
                openRecord(
                  { db, rec: recordSegment(row), title: row.title, number: row.number },
                  e,
                  () => router.push(recordHref(ws, db, row)),
                )
              }
              style={dot ? { borderLeftColor: dot, borderLeftWidth: 3 } : undefined}
              className="cursor-pointer rounded-[var(--radius-card)] border border-border-default bg-card p-4 hover:border-border-strong"
            >
              <p className="text-title font-semibold text-ink">{row.title || 'Untitled'}</p>
              {preview && <p className="mt-1.5 line-clamp-4 text-body text-ink-secondary">{preview}</p>}
              {cardFields.length > 0 && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {cardFields.map((field) => {
                    const value = field.type === 'title' ? row.title : row.values[field.apiName];
                    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
                    return (
                      <CardFieldChip key={field.id} field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
                    );
                  })}
                </div>
              )}
              {/* #706 tail — MUTED, not faint. This line is the card's provenance: who
                  wrote it and when. globals.css reserves faint for "genuinely
                  decorative text"; a name and a date are prose. Measured on a white
                  card: faint 3.44:1 (fails AA), muted 5.73:1 (passes). */}
              <div className="mt-3 border-t border-border-default pt-2 text-meta text-muted">
                <div className="flex flex-wrap items-center gap-1.5">
                  {author && <Avatar userId={author} name={memberNames.get(author) ?? '?'} image={memberImages?.get(author)} size={16} />}
                  {author && <span>{memberNames.get(author) ?? 'Someone'}</span>}
                  <span>·</span>
                  {/* #790 (F1) — prints the field actually being sorted by, not
                      always created_at: labeled when it isn't the default
                      ("Updated 3 Mar", "Due 14 Mar"), plain when it is (the
                      common case, unchanged from before). A date shown here
                      that isn't what the view is ordered by is decoration
                      pretending to be an explanation. */}
                  <span>
                    {sortField && sortField.apiName !== 'created_at' && rowDate
                      ? `${sortField.displayName} ${fmt.date(rowDate)}`
                      : fmt.date(row.created_at)}
                  </span>
                  {/* Quick-actions (#76): change status, complete, assign, open — all
                      optimistic writes via the records API, no navigation required. */}
                  <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {canAct && statusField && (
                      <StatusAction
                        ws={ws}
                        db={db}
                        field={statusField}
                        value={row.values[statusField.apiName]}
                        onCommit={(value) => updateRecord.mutate({ rec: row.id, values: { [statusField.apiName]: value } })}
                      />
                    )}
                    {canAct && checkboxField && (
                      <CheckboxAction
                        field={checkboxField}
                        value={row.values[checkboxField.apiName]}
                        onCommit={(value) => updateRecord.mutate({ rec: row.id, values: { [checkboxField.apiName]: value } })}
                      />
                    )}
                    {canAct && userField && (
                      <AssignAction
                        ws={ws}
                        db={db}
                        field={userField}
                        value={row.values[userField.apiName]}
                        members={memberList}
                        memberNames={memberNames}
                        memberImages={memberImages}
                        onCommit={(value) => updateRecord.mutate({ rec: row.id, values: { [userField.apiName]: value } })}
                      />
                    )}
                    <Link
                      href={recordHref(ws, db, row)}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRecord({ db, rec: recordSegment(row), title: row.title, number: row.number }, e);
                      }}
                      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-muted hover:bg-hover hover:text-ink"
                      title="Open"
                    >
                      <Maximize2 className="h-3 w-3" /> Open
                    </Link>
                    {row.number !== null && !numberHidden && <RecordNumberBadge number={row.number} className="text-meta" />}
                  </div>
                </div>
                {canComment && (
                  <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                    <CommentComposer ws={ws} db={db} rec={row.id} compact />
                  </div>
                )}
              </div>
            </div>
            </Fragment>
          );
        })}
        {records.hasNextPage && (
          <button
            className="self-center rounded px-2 py-1 text-body text-info hover:bg-hover"
            onClick={() => void records.fetchNextPage()}
            disabled={records.isFetchingNextPage}
          >
            {records.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Inline status/select action (#76): a pill showing the current option that opens
 * the same select editor popover table view uses (CellEditor), reused rather than
 * rebuilt so the option list, colors, and clear behavior stay identical. */
function StatusAction({
  ws,
  db,
  field,
  value,
  onCommit,
}: {
  ws: string;
  db: string;
  field: Field;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const option = field.options?.find((o) => o.id === value);
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setEditing((v) => !v)}
        className="rounded-full px-1.5 py-0.5 hover:bg-hover"
        title={`Change ${field.displayName}`}
      >
        {/* #706 tail — muted: this is the ONLY label on a button
            (title={`Change ${field.displayName}`}), not a decorative placeholder. */}
        {option ? <OptionChip option={option} /> : <span className="text-muted">{field.displayName}</span>}
      </button>
      {editing && (
        <CellEditor
          ws={ws}
          db={db}
          field={field}
          value={value}
          members={[]}
          onCommit={(v) => {
            onCommit(v);
            setEditing(false);
          }}
          // MN-279: multi-select toggles persist immediately without closing
          // the popover — bypasses the setEditing(false) above.
          onToggleImmediate={(v) => onCommit(v)}
          onCancel={() => setEditing(false)}
        />
      )}
    </span>
  );
}

/** Inline checkbox action (#76): direct toggle, optimistic via the same
 * updateRecord mutation as every other quick-action. */
function CheckboxAction({
  field,
  value,
  onCommit,
}: {
  field: Field;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  return (
    <label
      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 hover:bg-hover"
      title={field.displayName}
    >
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onCommit(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer"
      />
    </label>
  );
}

/** Inline assign action (#76): a person picker reusing CellEditor's user-type
 * editor (the same avatar-list popover table view uses for a `user` field). */
function AssignAction({
  ws,
  db,
  field,
  value,
  members,
  memberNames,
  memberImages,
  onCommit,
}: {
  ws: string;
  db: string;
  field: Field;
  value: unknown;
  members: Array<{ id: string; name: string; image?: string | null }>;
  memberNames: Map<string, string>;
  memberImages: Map<string, string | null>;
  onCommit: (value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ids = value == null ? [] : Array.isArray(value) ? (value as string[]) : [String(value)];
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setEditing((v) => !v)}
        className={cn(
          'flex items-center gap-1 rounded-full px-1.5 py-0.5 hover:bg-hover',
          // #706 tail — DELIBERATELY FAINT, do not "fix" this one. When nobody is
          // assigned the button's entire content is a bare UserPlus icon with no
          // text, so it is judged at 3:1 for non-text graphics, not 4.5:1. #665
          // kept nine sites of exactly this shape for the same reason.
          ids.length === 0 && 'text-faint',
        )}
        title={`Assign ${field.displayName}`}
      >
        {ids.length > 0 ? (
          ids.map((id) => (
            <Avatar key={id} userId={id} name={memberNames.get(id) ?? '?'} image={memberImages.get(id)} size={16} />
          ))
        ) : (
          <UserPlus className="h-3.5 w-3.5" />
        )}
      </button>
      {editing && (
        <CellEditor
          ws={ws}
          db={db}
          field={field}
          value={value}
          members={members}
          onCommit={(v) => {
            onCommit(v);
            setEditing(false);
          }}
          // MN-279: multi-select toggles persist immediately without closing
          // the popover — bypasses the setEditing(false) above.
          onToggleImmediate={(v) => onCommit(v)}
          onCancel={() => setEditing(false)}
        />
      )}
    </span>
  );
}
