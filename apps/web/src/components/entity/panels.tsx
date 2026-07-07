'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Segment = { type: 'text'; text: string } | { type: 'mention'; user_id: string };

interface Comment {
  id: string;
  body: Segment[];
  author: { id: string; name: string; image: string | null };
  created_at: string;
  edited_at: string | null;
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

  const [segments, setSegments] = useState<Segment[]>([]);
  const [text, setText] = useState('');

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
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['activity', ws, db, rec] });
    },
    onError: () => toast.error('Could not post the comment'),
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

  function submit() {
    const body: Segment[] = [...segments];
    if (text.trim()) body.push({ type: 'text', text: text.trim() });
    if (body.length === 0) return;
    post.mutate(body);
  }

  return (
    <div className="flex flex-col gap-3">
      {(comments.data ?? []).map((comment) => (
        <div key={comment.id} className="group rounded-[var(--radius-card)] border border-border-default bg-card p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium text-ink">{comment.author.name}</span>
            <span className="flex items-center gap-2 text-[11px] text-faint">
              {new Date(comment.created_at).toLocaleString()}
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
              ) : (
                <span key={i} className="rounded bg-accent-soft px-1 font-medium text-ink">
                  @{memberNames.get(segment.user_id) ?? 'unknown'}
                </span>
              ),
            )}
          </p>
        </div>
      ))}

      <div className="flex items-start gap-2">
        <div className="flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5">
          {segments.length > 0 && (
            <span className="mr-1">
              {segments.map((segment, i) =>
                segment.type === 'mention' ? (
                  <span key={i} className="mr-1 rounded bg-accent-soft px-1 text-[12px] font-medium text-ink">
                    @{memberNames.get(segment.user_id)}
                  </span>
                ) : (
                  <span key={i} className="mr-1 text-[13px]">{segment.text}</span>
                ),
              )}
            </span>
          )}
          <input
            className="w-full bg-card text-[13px] text-ink outline-none placeholder:text-faint"
            placeholder="Write a comment… (@ to mention)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
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
        <Button size="sm" onClick={submit} disabled={post.isPending}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
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
            {new Date(event.created_at).toLocaleString()}
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
