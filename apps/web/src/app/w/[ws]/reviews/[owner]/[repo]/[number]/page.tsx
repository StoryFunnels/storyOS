'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  MessageSquare,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DiffView } from '@/components/reviews/diff-view';
import type { DiffMode } from '@/components/reviews/diff-view';

interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
}
interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}
interface PullDetail {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  author_login: string | null;
  base_ref: string;
  head_ref: string;
  files: PullFile[];
  checks: CheckRun[];
}
interface CommentRow {
  id: string;
  comment_id: string;
  in_reply_to_id: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  author_login: string | null;
  body: string;
  reactions: Record<string, number>;
  created_at: string;
}

export default function PullRequestReviewPage() {
  const { ws, owner, repo, number } = useParams<{ ws: string; owner: string; repo: string; number: string }>();
  const qc = useQueryClient();
  const n = Number(number);
  const [mode, setMode] = useState<DiffMode>('unified');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ path: string; line: number; side: 'LEFT' | 'RIGHT' } | null>(null);
  const [draft, setDraft] = useState('');
  const [reviewBody, setReviewBody] = useState('');

  const basePath = `/api/v1/workspaces/{ws}/integrations/github/reviews/{owner}/{repo}/{number}` as const;
  const pathParams = { ws, owner, repo, number: n };

  const pull = useQuery({
    queryKey: ['pr', ws, owner, repo, n],
    queryFn: async () => {
      const { data, error } = await api.GET(basePath, { params: { path: pathParams } } as never);
      if (error) throw error;
      return data as unknown as PullDetail;
    },
  });

  const comments = useQuery({
    queryKey: ['pr-comments', ws, owner, repo, n],
    queryFn: async () => {
      const { data, error } = await api.GET(`${basePath}/comments` as never, {
        params: { path: pathParams },
      } as never);
      if (error) throw error;
      return data as unknown as CommentRow[];
    },
  });

  const files = pull.data?.files ?? [];
  const active = files.find((f) => f.filename === selectedFile) ?? files[0] ?? null;

  const threadsForActive = useMemo(() => {
    if (!active) return [];
    return (comments.data ?? []).filter((c) => c.path === active.filename);
  }, [comments.data, active]);

  const threadMarkers = useMemo(
    () =>
      threadsForActive
        .filter((c) => !c.in_reply_to_id && c.line !== null && c.side)
        .map((c) => ({ line: c.line!, side: c.side as 'LEFT' | 'RIGHT', count: 1 })),
    [threadsForActive],
  );

  const sync = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST(`${basePath}/comments/sync` as never, {
        params: { path: pathParams },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pr-comments', ws, owner, repo, n] }),
  });

  const postComment = useMutation({
    mutationFn: async (input: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }) => {
      const { error } = await api.POST(`${basePath}/comments` as never, {
        params: { path: pathParams },
        body: input as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      setComposing(null);
      setDraft('');
      void qc.invalidateQueries({ queryKey: ['pr-comments', ws, owner, repo, n] });
    },
  });

  const reply = useMutation({
    mutationFn: async ({ commentId, body }: { commentId: string; body: string }) => {
      const { error } = await api.POST(`${basePath}/comments/{commentId}/replies` as never, {
        params: { path: { ...pathParams, commentId } },
        body: { body } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pr-comments', ws, owner, repo, n] }),
  });

  const react = useMutation({
    mutationFn: async ({ commentId, content }: { commentId: string; content: string }) => {
      const { error } = await api.POST(`${basePath}/comments/{commentId}/reactions` as never, {
        params: { path: { ...pathParams, commentId } },
        body: { content } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pr-comments', ws, owner, repo, n] }),
  });

  const submitReview = useMutation({
    mutationFn: async (event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') => {
      const { error } = await api.POST(`${basePath}/reviews` as never, {
        params: { path: pathParams },
        body: { event, body: reviewBody || undefined } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => setReviewBody(''),
  });

  if (pull.isLoading) return <div className="p-8 text-sm text-muted">Loading…</div>;
  if (pull.isError) {
    return (
      <div className="p-8 text-[13px] text-error">{apiErrorMessage(pull.error, 'Could not load this pull request')}</div>
    );
  }
  const pr = pull.data!;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border-default p-4">
        <Link href={`/w/${ws}/reviews`} className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> Reviews
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-[16px] font-semibold text-ink">
              {pr.title} <span className="font-normal text-faint">#{pr.number}</span>
            </h1>
            <p className="mt-0.5 text-[12px] text-muted">
              {pr.repo} · {pr.author_login} wants to merge into{' '}
              <code className="text-ink">{pr.base_ref}</code> from <code className="text-ink">{pr.head_ref}</code>
              {pr.draft && <span className="ml-1.5 rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">Draft</span>}
            </p>
          </div>
          <a
            href={pr.html_url}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1 text-[12px] text-info hover:underline"
          >
            View on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {pr.checks.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {pr.checks.map((c) => (
              <span key={c.name} className="flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-secondary">
                <CheckIcon conclusion={c.conclusion} status={c.status} />
                {c.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-64 shrink-0 overflow-y-auto border-r border-border-default">
          {files.map((f) => (
            <button
              key={f.filename}
              onClick={() => setSelectedFile(f.filename)}
              className={cn(
                'flex w-full items-center gap-1.5 border-b border-border-default px-3 py-2 text-left text-[12px] hover:bg-hover',
                active?.filename === f.filename ? 'bg-active text-ink' : 'text-ink-secondary',
              )}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate">{f.filename}</span>
              <span className="shrink-0 text-[10px]">
                <span className="text-success">+{f.additions}</span> <span className="text-error">-{f.deletions}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-border-default px-3 py-1.5">
            <span className="truncate text-[12px] font-medium text-ink">{active?.filename}</span>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending}>
                <RefreshCw className={cn('h-3.5 w-3.5', sync.isPending && 'animate-spin')} />
              </Button>
              <div className="flex rounded-[var(--radius-control)] border border-border-default text-[11px]">
                {(['unified', 'split'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'px-2 py-1 capitalize first:rounded-l-[var(--radius-control)] last:rounded-r-[var(--radius-control)]',
                      mode === m ? 'bg-active text-ink' : 'text-muted hover:text-ink',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {active && (
              <DiffView
                patch={active.patch}
                mode={mode}
                threads={threadMarkers}
                onCommentLine={(line, side) => {
                  setComposing({ path: active.filename, line, side });
                  setDraft('');
                }}
              />
            )}
          </div>

          {composing && (
            <div className="shrink-0 border-t border-border-default bg-card p-3">
              <p className="mb-1.5 text-[11px] text-muted">
                Commenting on <code className="text-ink">{composing.path}</code>:{composing.line} ({composing.side})
              </p>
              <textarea
                autoFocus
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Leave a comment…"
                className="w-full rounded-[var(--radius-control)] border border-border-default bg-surface px-2 py-1.5 text-[13px] text-ink outline-none focus:border-border-strong"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setComposing(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!draft.trim() || postComment.isPending}
                  onClick={() => postComment.mutate({ ...composing, body: draft.trim() })}
                >
                  Comment
                </Button>
              </div>
            </div>
          )}

          {threadsForActive.length > 0 && (
            <div className="max-h-64 shrink-0 overflow-y-auto border-t border-border-default">
              {groupThreads(threadsForActive).map((thread) => (
                <div key={thread[0]!.comment_id} className="border-b border-border-default p-3 last:border-b-0">
                  {thread.map((c) => (
                    <div key={c.id} className={cn('mb-2 last:mb-0', c.in_reply_to_id && 'ml-4')}>
                      <div className="flex items-center gap-2 text-[11px] text-faint">
                        <span className="font-medium text-ink-secondary">{c.author_login ?? 'unknown'}</span>
                        line {c.line}
                      </div>
                      <p className="whitespace-pre-wrap text-[13px] text-ink">{c.body}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <button
                          className="text-[11px] text-muted hover:text-ink"
                          onClick={() => react.mutate({ commentId: c.comment_id, content: '+1' })}
                        >
                          👍 {c.reactions['+1'] ?? ''}
                        </button>
                        <ReplyButton onReply={(body) => reply.mutate({ commentId: c.comment_id, body })} />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border-default p-3">
        <textarea
          rows={1}
          value={reviewBody}
          onChange={(e) => setReviewBody(e.target.value)}
          placeholder="Overall review comment (optional)…"
          className="min-h-9 flex-1 resize-none rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5 text-[13px] text-ink outline-none focus:border-border-strong"
        />
        <Button variant="secondary" size="sm" disabled={submitReview.isPending} onClick={() => submitReview.mutate('COMMENT')}>
          <MessageSquare className="h-3.5 w-3.5" /> Comment
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={submitReview.isPending}
          onClick={() => submitReview.mutate('REQUEST_CHANGES')}
        >
          Request changes
        </Button>
        <Button size="sm" disabled={submitReview.isPending} onClick={() => submitReview.mutate('APPROVE')}>
          <Check className="h-3.5 w-3.5" /> Approve
        </Button>
      </div>
    </div>
  );
}

function CheckIcon({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== 'completed') return <Circle className="h-3 w-3 text-warning" />;
  if (conclusion === 'success') return <CheckCircle2 className="h-3 w-3 text-success" />;
  if (conclusion === 'failure' || conclusion === 'timed_out') return <XCircle className="h-3 w-3 text-error" />;
  return <Circle className="h-3 w-3 text-muted" />;
}

/** Root comments (no parent) each followed by their replies, in creation order. */
function groupThreads(comments: CommentRow[]): CommentRow[][] {
  const roots = comments.filter((c) => !c.in_reply_to_id);
  const byParent = new Map<string, CommentRow[]>();
  for (const c of comments) {
    if (!c.in_reply_to_id) continue;
    const list = byParent.get(c.in_reply_to_id) ?? [];
    list.push(c);
    byParent.set(c.in_reply_to_id, list);
  }
  return roots.map((root) => [root, ...(byParent.get(root.comment_id) ?? [])]);
}

function ReplyButton({ onReply }: { onReply: (body: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  if (!open) {
    return (
      <button className="text-[11px] text-muted hover:text-ink" onClick={() => setOpen(true)}>
        Reply
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onReply(value.trim());
            setValue('');
            setOpen(false);
          }
        }}
        placeholder="Reply…"
        className="rounded border border-border-default bg-surface px-1.5 py-0.5 text-[11px] text-ink outline-none"
      />
    </span>
  );
}
