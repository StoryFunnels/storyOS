'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDateFormat } from '@/lib/preferences';
import { Paperclip, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Segment =
  | { type: 'text'; text: string }
  | { type: 'mention'; user_id: string }
  /** #record mention (#140): id is durable, database_id makes the chip navigable. */
  | { type: 'record'; record_id: string; database_id: string };

/** Live-title record chip for a #mention in a comment — store the id, render the label. */
function CommentRecordChip({ ws, segment }: { ws: string; segment: { record_id: string; database_id: string } }) {
  const record = useQuery({
    queryKey: ['mention-record', ws, segment.database_id, segment.record_id],
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}',
        { params: { path: { ws, db: segment.database_id, rec: segment.record_id } } },
      );
      if (error) {
        if (response.status === 404) return { deleted: true as const };
        throw error;
      }
      return data as unknown as { title: string };
    },
  });
  const deleted = record.data && 'deleted' in record.data;
  const title = record.data && 'title' in record.data ? record.data.title : '…';
  if (deleted) {
    return <span className="rounded bg-accent-soft px-1 font-medium text-faint line-through">#deleted</span>;
  }
  return (
    <Link
      href={`/w/${ws}/d/${segment.database_id}/r/${segment.record_id}`}
      className="rounded bg-accent-soft px-1 font-medium text-[var(--accent)] no-underline"
    >
      #{title || 'Untitled'}
    </Link>
  );
}

interface Comment {
  id: string;
  body: Segment[];
  author: { id: string; name: string; image: string | null };
  created_at: string;
  edited_at: string | null;
}

/** "#" button in the comment composer: search records (grant-scoped), insert a chip. */
function RecordMentionButton({
  ws,
  onPick,
}: {
  ws: string;
  onPick: (recordId: string, databaseId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const results = useQuery({
    queryKey: ['comment-record-picker', ws, search],
    enabled: open && search.trim().length > 0,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/search', {
        params: { path: { ws }, query: { q: search.trim() } },
      } as never);
      if (error) throw error;
      return (data as unknown as {
        records: Array<{ id: string; title: string; database_id: string; database_name: string }>;
      }).records;
    },
  });

  return (
    <span className="relative">
      <Button variant="secondary" size="sm" title="Mention a record" onClick={() => setOpen((v) => !v)}>
        #
      </Button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 w-72 rounded-[var(--radius-card)] border border-border-default bg-card p-2 shadow-[0_8px_24px_rgba(15,23,41,0.15)]">
          <input
            autoFocus
            className="mb-1 h-8 w-full rounded-md border border-border-default bg-card px-2 text-[13px] text-ink"
            placeholder="Search records…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="max-h-48 overflow-y-auto">
            {(results.data ?? []).map((r) => (
              <button
                key={r.id}
                className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[13px] text-ink hover:bg-hover"
                onClick={() => {
                  onPick(r.id, r.database_id);
                  setOpen(false);
                  setSearch('');
                }}
              >
                <span className="truncate">{r.title || 'Untitled'}</span>
                <span className="shrink-0 text-[11px] text-faint">{r.database_name}</span>
              </button>
            ))}
            {search.trim() && results.data?.length === 0 && (
              <p className="px-2 py-1 text-[12px] text-faint">No matches.</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * The comment composer (@ mentions, # record mentions, submit) — factored out of
 * CommentsPanel (#76) so the feed view's inline per-card composer reuses the exact
 * same posting logic/UI instead of a second one-off implementation. `compact`
 * collapses the @/# toolbar until the input is focused or already has a draft in
 * it (expand-on-focus), for a footer-sized inline composer.
 */
export function CommentComposer({
  ws,
  db,
  rec,
  members,
  compact = false,
  onPosted,
}: {
  ws: string;
  db: string;
  rec: string;
  members: Array<{ id: string; name: string }>;
  compact?: boolean;
  onPosted?: () => void;
}) {
  const qc = useQueryClient();
  const key = ['comments', ws, db, rec];
  const memberNames = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  const post = useMutation({
    mutationFn: async (body: Segment[]) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments',
        { params: { path: { ws, db, rec } }, body: { body: body as never } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      setSegments([]);
      setText('');
      setFocused(false);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['activity', ws, db, rec] });
      onPosted?.();
    },
    onError: () => toast.error('Could not post the comment'),
  });

  function submit() {
    const body: Segment[] = [...segments];
    if (text.trim()) body.push({ type: 'text', text: text.trim() });
    if (body.length === 0) return;
    post.mutate(body);
  }

  // A compact composer only shows the @/# toolbar and send button once there's
  // something to act on — focused, or a draft already started.
  const toolbarShown = !compact || focused || segments.length > 0 || text.trim().length > 0;

  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          'flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2',
          compact ? 'py-1' : 'py-1.5',
        )}
      >
        {segments.length > 0 && (
          <span className="mr-1">
            {segments.map((segment, i) =>
              segment.type === 'mention' ? (
                <span key={i} className="mr-1 rounded bg-accent-soft px-1 text-[12px] font-medium text-ink">
                  @{memberNames.get(segment.user_id)}
                </span>
              ) : segment.type === 'record' ? (
                <span key={i} className="mr-1 rounded bg-accent-soft px-1 text-[12px] font-medium text-ink">
                  <CommentRecordChip ws={ws} segment={segment} />
                </span>
              ) : (
                <span key={i} className="mr-1 text-[13px]">{segment.text}</span>
              ),
            )}
          </span>
        )}
        <input
          className="w-full bg-card text-[13px] text-ink outline-none placeholder:text-faint"
          placeholder="Write a comment… (@ people, # records)"
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            if (!text.trim() && segments.length === 0) setFocused(false);
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape' && compact) (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      {toolbarShown && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" title="Mention someone">
                @
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {members.map((member) => (
                <DropdownMenuItem
                  key={member.id}
                  onSelect={() => {
                    setSegments((prev) => [
                      ...prev,
                      ...(text.trim() ? [{ type: 'text', text: `${text.trim()} ` } as Segment] : []),
                      { type: 'mention', user_id: member.id },
                    ]);
                    setText('');
                  }}
                >
                  {member.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <RecordMentionButton
            ws={ws}
            onPick={(record_id, database_id) => {
              setSegments((prev) => [
                ...prev,
                ...(text.trim() ? [{ type: 'text', text: `${text.trim()} ` } as Segment] : []),
                { type: 'record', record_id, database_id },
              ]);
              setText('');
            }}
          />
          <Button size="sm" onClick={submit} disabled={post.isPending}>
            <Send className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

export function CommentsPanel({
  ws,
  db,
  rec,
  members,
  currentUserId,
  isAdmin,
}: {
  ws: string;
  db: string;
  rec: string;
  members: Array<{ id: string; name: string }>;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const fmt = useDateFormat();
  const key = ['comments', ws, db, rec];
  const memberNames = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);

  const comments = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments',
        { params: { path: { ws, db, rec } } },
      );
      if (error) throw error;
      return (data as unknown as { data: Comment[] }).data;
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments/{comment}',
        { params: { path: { ws, db, rec, comment: id } } },
      );
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <div className="flex flex-col gap-3">
      {(comments.data ?? []).map((comment) => (
        <div key={comment.id} className="group rounded-[var(--radius-card)] border border-border-default bg-card p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
              <Avatar userId={comment.author.id} name={comment.author.name} image={comment.author.image} size={20} />
              {comment.author.name}
            </span>
            <span className="flex items-center gap-2 text-[11px] text-faint">
              {fmt.dateTime(comment.created_at)}
              {(comment.author.id === currentUserId || isAdmin) && (
                <button
                  className="opacity-0 hover:text-error group-hover:opacity-100"
                  onClick={() => remove.mutate(comment.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            {comment.body.map((segment, i) =>
              segment.type === 'text' ? (
                <span key={i}>{segment.text}</span>
              ) : segment.type === 'record' ? (
                <CommentRecordChip key={i} ws={ws} segment={segment} />
              ) : (
                <span key={i} className="rounded bg-accent-soft px-1 font-medium text-ink">
                  @{memberNames.get(segment.user_id) ?? 'unknown'}
                </span>
              ),
            )}
          </p>
        </div>
      ))}

      <CommentComposer ws={ws} db={db} rec={rec} members={members} />
    </div>
  );
}

interface ActivityEntry {
  id: string;
  type: string;
  actor: { id: string; name: string } | null;
  payload: Record<string, unknown>;
  changes?: Array<{ field: string; from: unknown; to: unknown }>;
  created_at: string;
}

const EVENT_LABELS: Record<string, string> = {
  'record.created': 'created this record',
  'record.deleted': 'moved this record to trash',
  'record.restored': 'restored this record',
  'relation.linked': 'linked',
  'relation.unlinked': 'unlinked',
  'comment.created': 'commented',
  'document.edited': 'edited the description',
  'attachment.added': 'added an attachment',
};

export function ActivityPanel({ ws, db, rec }: { ws: string; db: string; rec: string }) {
  const dates = useDateFormat();
  const activity = useQuery({
    queryKey: ['activity', ws, db, rec],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/activity',
        { params: { path: { ws, db, rec } } },
      );
      if (error) throw error;
      return (data as unknown as { data: ActivityEntry[] }).data;
    },
  });

  const fmt = (value: unknown): string => {
    if (value === null || value === undefined) return 'empty';
    if (Array.isArray(value)) return value.map(fmt).join(', ');
    return String(value);
  };

  return (
    <div className="flex flex-col gap-2">
      {(activity.data ?? []).map((event) => (
        <div key={event.id} className="flex items-baseline gap-2 text-[12px]">
          <span className="whitespace-nowrap text-faint">
            {dates.dateTime(event.created_at)}
          </span>
          <span className="text-ink-secondary">
            <span className="font-medium text-ink">{event.actor?.name ?? 'Someone'}</span>{' '}
            {event.type === 'record.updated' && event.changes ? (
              <>
                changed{' '}
                {event.changes.map((change, i) => (
                  <span key={i}>
                    {i > 0 && '; '}
                    <span className="font-medium">{change.field}</span>: {fmt(change.from)} →{' '}
                    {fmt(change.to)}
                  </span>
                ))}
              </>
            ) : event.type.startsWith('relation.') ? (
              <>
                {EVENT_LABELS[event.type]}{' '}
                <span className="font-medium">
                  {(event.payload.other as { title?: string })?.title ?? 'a record'}
                </span>
              </>
            ) : (
              (EVENT_LABELS[event.type] ?? event.type)
            )}
          </span>
        </div>
      ))}
      {(activity.data ?? []).length === 0 && <p className="text-[13px] text-muted">No activity yet.</p>}
    </div>
  );
}

interface Backlink {
  id: string;
  title: string;
  number: number | null;
  database_id: string;
  database_name: string;
}

/**
 * "Mentioned in" (MN-205): the records whose document #-mentions this one. A one-way
 * mention is half a relation — this is the other half, so you can traverse back. The
 * list is permission-scoped server-side (a title you can't open never appears here).
 */
export function MentionedIn({ ws, db, rec }: { ws: string; db: string; rec: string }) {
  const backlinks = useQuery({
    queryKey: ['backlinks', ws, db, rec],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/backlinks',
        { params: { path: { ws, db, rec } } },
      );
      if (error) throw error;
      return (data as unknown as { data: Backlink[] }).data;
    },
  });

  const items = backlinks.data ?? [];
  if (items.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">
        Mentioned in
      </h2>
      <ul className="flex flex-col gap-1">
        {items.map((b) => (
          <li key={b.id}>
            <Link
              href={`/w/${ws}/d/${b.database_id}/r/${b.id}`}
              className="flex items-baseline gap-2 rounded px-2 py-1 text-[13px] hover:bg-hover"
            >
              <span className="truncate text-ink">{b.title || 'Untitled'}</span>
              <span className="shrink-0 text-[11px] text-faint">{b.database_name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Attachment {
  id: string;
  filename: string;
  size: number;
  mime: string;
  has_thumbnail: boolean;
  created_at: string;
}

export function AttachmentsStrip({
  ws,
  db,
  rec,
  readOnly,
}: {
  ws: string;
  db: string;
  rec: string;
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const key = ['attachments', ws, db, rec];
  const [dragOver, setDragOver] = useState(false);
  const base = `${API_URL}/api/v1/workspaces/${ws}/databases/${db}/records/${rec}/attachments`;

  const attachments = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/attachments',
        { params: { path: { ws, db, rec } } },
      );
      if (error) throw error;
      return (data as unknown as { data: Attachment[] }).data;
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(base, { method: 'POST', credentials: 'include', body: form });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: () => toast.error('Upload failed — too large?'),
  });

  const remove = useMutation({
    mutationFn: async (att: string) => {
      const { error } = await api.DELETE(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/attachments/{att}',
        { params: { path: { ws, db, rec, att } } },
      );
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border border-dashed border-border-strong p-3',
        dragOver && 'border-[var(--accent)] bg-accent-soft',
      )}
      onDragOver={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setDragOver(false);
        for (const file of Array.from(e.dataTransfer.files)) upload.mutate(file);
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
          <Paperclip className="h-3.5 w-3.5" /> Attachments
        </span>
        {!readOnly && (
          <label className="cursor-pointer text-[12px] text-info underline">
            {upload.isPending ? 'Uploading…' : 'Upload'}
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {(attachments.data ?? []).map((att) => (
          <div
            key={att.id}
            className="group flex w-36 flex-col rounded-[var(--radius-control)] border border-border-default bg-card p-2"
          >
            {att.has_thumbnail ? (
              <img
                src={`${base}/${att.id}/thumbnail`}
                alt={att.filename}
                className="mb-1 h-20 w-full rounded object-cover"
              />
            ) : (
              <div className="mb-1 flex h-20 items-center justify-center rounded bg-hover text-[11px] uppercase text-faint">
                {att.filename.split('.').pop()}
              </div>
            )}
            <a
              href={`${base}/${att.id}/download`}
              className="truncate text-[12px] text-ink hover:underline"
              title={att.filename}
            >
              {att.filename}
            </a>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-faint">{(att.size / 1024).toFixed(0)} KB</span>
              {!readOnly && (
                <button
                  className="text-faint opacity-0 hover:text-error group-hover:opacity-100"
                  onClick={() => remove.mutate(att.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        ))}
        {(attachments.data ?? []).length === 0 && (
          <p className="text-[12px] text-faint">Drop files here or use Upload.</p>
        )}
      </div>
    </div>
  );
}
