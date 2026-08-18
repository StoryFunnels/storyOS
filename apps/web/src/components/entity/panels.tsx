'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDateFormat } from '@/lib/preferences';
import { Paperclip, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { api, API_URL } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { MentionScope, MentionSuggestionMenus, mentionSchema } from './mentions';

type Segment =
  | { type: 'text'; text: string }
  | { type: 'mention'; user_id: string }
  /** #record mention (#140): id is durable, database_id makes the chip navigable. */
  | { type: 'record'; record_id: string; database_id: string };

/**
 * New comments (#180) are authored in BlockNote and stored in this discriminated
 * shape — unambiguously distinct from the legacy `Segment[]` array so the reader
 * can pick the right renderer. `doc` is the BlockNote document JSON.
 */
interface BlocknoteBody {
  format: 'blocknote';
  doc: unknown[];
}

/** A comment body is EITHER the legacy segment array OR the new BlockNote shape. */
type CommentBody = Segment[] | BlocknoteBody;

function isBlocknoteBody(body: CommentBody): body is BlocknoteBody {
  return !Array.isArray(body) && (body as BlocknoteBody)?.format === 'blocknote';
}

/** True when a BlockNote doc carries no text/content — a single empty paragraph,
 *  as BlockNote always keeps at least one block. Keeps empty comments unpostable. */
function isDocEmpty(blocks: unknown[]): boolean {
  return blocks.every((b) => {
    const block = (b ?? {}) as { type?: string; content?: unknown; children?: unknown };
    // Any non-paragraph block (heading, list item, image, table…) is real content.
    if (block.type && block.type !== 'paragraph') return false;
    const content = block.content;
    const hasInline = Array.isArray(content)
      ? content.some((c) => {
          const node = c as { type?: string; text?: string };
          return node.type === 'text' ? (node.text ?? '').trim() !== '' : Boolean(node.type);
        })
      : typeof content === 'string'
        ? content.trim() !== ''
        : Boolean(content);
    const hasChildren = Array.isArray(block.children) && block.children.length > 0 && !isDocEmpty(block.children);
    return !hasInline && !hasChildren;
  });
}

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
  body: CommentBody;
  author: { id: string; name: string; image: string | null };
  created_at: string;
  edited_at: string | null;
}

/**
 * The comment composer — a BlockNote rich-text editor (#180). Rich text plus the
 * shared @/# mention menus and BlockNote's built-in `/` slash menu, identical to
 * the rich-text fields and the description editor. Factored out of CommentsPanel
 * (#76) so the feed view's inline per-card composer reuses the exact same posting
 * logic. `compact` collapses the Send button until the editor is focused or holds
 * a draft (expand-on-focus), for a footer-sized inline composer.
 *
 * On submit the BlockNote document is serialized to JSON and sent as
 * `{ format: 'blocknote', doc }` — the discriminated shape the server + reader
 * tell apart from legacy segment-array comments. Send via the button or
 * Cmd/Ctrl+Enter (plain Enter is a newline, as in any rich editor).
 */
export function CommentComposer({
  ws,
  db,
  rec,
  compact = false,
  onPosted,
}: {
  ws: string;
  db: string;
  rec: string;
  compact?: boolean;
  onPosted?: () => void;
}) {
  const qc = useQueryClient();
  const key = ['comments', ws, db, rec];
  const { resolved: theme } = useTheme();
  const [focused, setFocused] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  // Bumped after a successful post to remount a fresh, empty editor (BlockNote has
  // no clean "reset to empty" — recreating via this dep is the reliable clear).
  const [resetKey, setResetKey] = useState(0);

  const editor = useCreateBlockNote({ schema: mentionSchema }, [resetKey]);

  const post = useMutation({
    mutationFn: async (body: BlocknoteBody) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments',
        { params: { path: { ws, db, rec } }, body: { body: body as never } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      setHasContent(false);
      setFocused(false);
      setResetKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['activity', ws, db, rec] });
      onPosted?.();
    },
    onError: () => toast.error('Could not post the comment'),
  });

  function submit() {
    const doc = editor.document as unknown[];
    if (isDocEmpty(doc)) return;
    post.mutate({ format: 'blocknote', doc });
  }

  // A compact composer only shows the send button once there's something to act
  // on — focused, or a draft already started.
  const toolbarShown = !compact || focused || hasContent;

  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          'flex-1 overflow-hidden rounded-[var(--radius-control)] border border-border-default bg-card',
          compact ? 'py-0.5' : 'py-1.5',
          '[&_.bn-editor]:bg-transparent [&_.bn-editor]:px-3 [&_.bn-editor]:py-0',
        )}
        // Cmd/Ctrl+Enter sends; plain Enter stays a newline in the rich editor.
        // Capture phase so it fires before ProseMirror handles the key.
        onKeyDownCapture={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node) && !hasContent) setFocused(false);
        }}
      >
        <MentionScope ws={ws}>
          <BlockNoteView
            /* #338: BlockNote mounts its own "/" menu unless this is off, and
               it wins over ours — so the reordered menu in MentionSuggestionMenus
               never rendered until this was set. Verified in the browser: group
               order stayed BlockNote's default with Emoji last at 22 of 23. */
            slashMenu={false}
            editor={editor}
            editable={!post.isPending}
            theme={theme}
            onChange={() => setHasContent(!isDocEmpty(editor.document as unknown[]))}
          >
            <MentionSuggestionMenus editor={editor as never} ws={ws} />
          </BlockNoteView>
        </MentionScope>
      </div>
      {toolbarShown && (
        <Button size="sm" onClick={submit} disabled={post.isPending}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * A stored BlockNote comment (#180) rendered read-only — the same editor + shared
 * `mentionSchema` the composer uses, so @/# mention chips resolve identically, but
 * non-editable. Legacy segment comments never reach here; they keep the flat
 * renderer below.
 */
function CommentBlockNoteBody({ ws, doc }: { ws: string; doc: unknown[] }) {
  const { resolved: theme } = useTheme();
  const editor = useCreateBlockNote({
    schema: mentionSchema,
    initialContent: doc.length > 0 ? (doc as never) : undefined,
  });
  return (
    <div className="text-[13px] leading-relaxed text-ink-secondary [&_.bn-editor]:bg-transparent [&_.bn-editor]:px-0 [&_.bn-editor]:py-0">
      <MentionScope ws={ws}>
        <BlockNoteView editor={editor} editable={false} theme={theme} />
      </MentionScope>
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

  // #269 — a notification links to /r/{rec}?comment={id}; once the thread loads,
  // scroll that comment into view and flash a highlight so it's obvious which
  // one the email/inbox pointed at. A missing/stale id just no-ops (opens thread).
  const searchParams = useSearchParams();
  const targetCommentId = searchParams.get('comment');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetCommentId || !comments.data) return;
    if (scrolledForRef.current === targetCommentId) return;
    if (!comments.data.some((c) => c.id === targetCommentId)) return;
    scrolledForRef.current = targetCommentId;
    const el = document.getElementById(`comment-${targetCommentId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(targetCommentId);
    const timer = setTimeout(() => setHighlightedId(null), 2200);
    return () => clearTimeout(timer);
  }, [targetCommentId, comments.data]);

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
        <div
          key={comment.id}
          id={`comment-${comment.id}`}
          className={cn(
            'group rounded-[var(--radius-card)] border border-border-default bg-card p-3 transition-shadow duration-500',
            highlightedId === comment.id && 'ring-2 ring-info',
          )}
        >
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
          {/* #180: new comments are BlockNote docs; legacy comments keep the flat
              segment renderer untouched. The stored shape decides which path runs. */}
          {isBlocknoteBody(comment.body) ? (
            <CommentBlockNoteBody ws={ws} doc={comment.body.doc} />
          ) : (
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
          )}
        </div>
      ))}

      <CommentComposer ws={ws} db={db} rec={rec} />
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
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-muted">
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
          <div key={att.id} className="group relative w-36">
            <a
              href={`${base}/${att.id}/download`}
              title={att.filename}
              className="flex w-36 cursor-pointer flex-col rounded-[var(--radius-control)] border border-border-default bg-card p-2 transition-colors hover:border-info hover:bg-hover"
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
              <span className="truncate text-[12px] text-ink">{att.filename}</span>
              <span className="text-[11px] text-faint">{(att.size / 1024).toFixed(0)} KB</span>
            </a>
            {!readOnly && (
              <button
                type="button"
                aria-label="Delete attachment"
                className="absolute right-1 top-1 rounded bg-card/80 p-0.5 text-faint opacity-0 hover:text-error group-hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  remove.mutate(att.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        {(attachments.data ?? []).length === 0 && (
          <p className="text-[12px] text-faint">Drop files here or use Upload.</p>
        )}
      </div>
    </div>
  );
}
