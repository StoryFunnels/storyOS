'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Maximize2, UserPlus } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { recordHref } from '@/lib/records';
import { useDateFormat } from '@/lib/preferences';
import { atLeast } from '@/lib/access';
import { cn } from '@/lib/utils';
import { CommentComposer } from '../entity/panels';
import { CardFieldChip } from './board-view';
import { CellEditor, OptionChip, richTextPreview, optionColor } from '../table-view/cells';
import { useDatabase, useMembers, useRecordMutations, useRecordsInfinite } from '../table-view/use-table-data';
import type { Field } from '../table-view/use-table-data';
import type { FilterNode, ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';
import { feedActionFields } from './feed-actions';

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
  const fmt = useDateFormat();
  const queryBody = useMemo(() => queryBodyFromConfig(config, personalFilter), [config, personalFilter]);
  const records = useRecordsInfinite(ws, db, queryBody);
  const { updateRecord } = useRecordMutations(ws, db);

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
  // Quick-actions row (#76): which select/checkbox/user field each action edits,
  // derived purely from the schema — omitted entirely when the database has none.
  const { statusField, checkboxField, userField } = useMemo(
    () => feedActionFields(database.data?.fields ?? [], config),
    [database.data, config],
  );
  const canAct = !readOnly;
  const canComment = atLeast(database.data?.my_access, 'commenter');

  if (rows.length === 0) return <p className="p-6 text-sm text-faint">No records yet.</p>;

  return (
    <div className="h-full overflow-auto">
      <div className="flex max-w-2xl flex-col gap-3 px-4 py-4">
        {rows.map((row) => {
          const preview = richField ? richTextPreview(row.values[richField.apiName], 280) : '';
          const author = row.created_by;
          const dot = colorField ? optionColor(colorField, row.values[colorField.apiName]) : null;
          return (
            <div
              key={row.id}
              onClick={() => router.push(recordHref(ws, db, row))}
              style={dot ? { borderLeftColor: dot, borderLeftWidth: 3 } : undefined}
              className="cursor-pointer rounded-[var(--radius-card)] border border-border-default bg-card p-4 hover:border-border-strong"
            >
              <p className="text-[15px] font-semibold text-ink">{row.title || 'Untitled'}</p>
              {preview && <p className="mt-1.5 line-clamp-4 text-[13px] text-ink-secondary">{preview}</p>}
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
              <div className="mt-3 border-t border-border-default pt-2 text-[11px] text-faint">
                <div className="flex flex-wrap items-center gap-1.5">
                  {author && <Avatar userId={author} name={memberNames.get(author) ?? '?'} image={memberImages?.get(author)} size={16} />}
                  {author && <span>{memberNames.get(author) ?? 'Someone'}</span>}
                  <span>·</span>
                  <span>{fmt.date(row.created_at)}</span>
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
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-faint hover:bg-hover hover:text-ink"
                      title="Open"
                    >
                      <Maximize2 className="h-3 w-3" /> Open
                    </Link>
                    {row.number !== null && <span className="tabular-nums">#{row.number}</span>}
                  </div>
                </div>
                {canComment && (
                  <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                    <CommentComposer ws={ws} db={db} rec={row.id} members={memberList} compact />
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {records.hasNextPage && (
          <button
            className="self-center rounded px-2 py-1 text-[13px] text-info hover:bg-hover"
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
        {option ? <OptionChip option={option} /> : <span className="text-faint">{field.displayName}</span>}
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
          onCancel={() => setEditing(false)}
        />
      )}
    </span>
  );
}
