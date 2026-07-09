'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useWorkspace } from '@/lib/queries';
import { atLeast } from '@/lib/access';
import { CellDisplay, CellEditor } from '@/components/table-view/cells';
import { RelationEditor } from '@/components/table-view/relation-cell';
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
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name })),
    [members.data],
  );
  const memberNames = useMemo(() => new Map(memberList.map((m) => [m.id, m.name])), [memberList]);

  const fields = useMemo(
    () => (database.data?.fields ?? []).filter((f) => !HIDDEN.has(f.type)),
    [database.data],
  );

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
        {fields.map((field) => (
          <PropertyRow
            key={field.id}
            ws={ws}
            db={db}
            rec={rec}
            field={field}
            record={record.data!}
            memberNames={memberNames}
            members={memberList}
            readOnly={readOnly}
            onCommit={(value) => updateRecord.mutate({ rec, values: { [field.apiName]: value } })}
          />
        ))}
      </div>

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
  members,
  readOnly,
  onCommit,
}: {
  ws: string;
  db: string;
  rec: string;
  field: Field;
  record: RecordRow;
  memberNames: Map<string, string>;
  members: Array<{ id: string; name: string }>;
  readOnly: boolean;
  onCommit: (value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const value = record.values[field.apiName];

  if (field.type === 'relation') {
    const chips = (value as LinkChip[]) ?? [];
    return (
      <div className="flex min-h-9 items-center border-b border-border-default py-1.5 last:border-b-0">
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
      </div>
    );
  }

  return (
    <div
      className="flex min-h-9 items-center border-b border-border-default py-1.5 last:border-b-0"
      onClick={() => {
        if (!readOnly && !editing && field.type !== 'checkbox') setEditing(true);
        if (!readOnly && field.type === 'checkbox') onCommit(!(value === true));
      }}
    >
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
        ) : value === undefined || value === null || value === '' ? (
          <span className="text-[13px] text-faint">Empty</span>
        ) : (
          <CellDisplay field={field} value={value} memberNames={memberNames} />
        )}
      </div>
    </div>
  );
}
