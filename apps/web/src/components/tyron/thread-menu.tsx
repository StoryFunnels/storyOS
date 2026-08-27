'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, MoreHorizontal, History } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm-dialog';

interface ThreadSummary {
  id: string;
  title: string;
  updated_at?: string;
}

/**
 * Reaching earlier conversations (#403).
 *
 * `GET /tyron/threads` was built in #359 and NOTHING consumed it. #359's user
 * story is "As a returning user, I want to find the conversation where we set
 * this up last month, still intact — not start again from nothing", and the
 * list that makes that possible is this component.
 *
 * The auto-naming #359 ships exists precisely so this reads as a list of
 * conversations rather than a column of "New chat".
 */
export function ThreadMenu({
  ws,
  threadId,
  onPick,
}: {
  ws: string;
  threadId: string | null;
  onPick: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const threads = useQuery({
    queryKey: ['tyron-threads', ws],
    // Only fetched while the list is open — a panel that is mostly used for one
    // conversation should not poll a list nobody is looking at.
    enabled: open,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/tyron/threads', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      const raw = data as unknown as ThreadSummary[] | { data: ThreadSummary[] };
      return Array.isArray(raw) ? raw : raw.data;
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tyron-threads', ws] });
    void qc.invalidateQueries({ queryKey: ['tyron-thread', ws] });
  };

  const rename = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/tyron/threads/{thread}', {
        params: { path: { ws, thread: id } },
        body: { title } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: () => toast.error('Could not rename the conversation'),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/tyron/threads/{thread}', {
        params: { path: { ws, thread: id } },
      } as never);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      // Deleting the conversation you are IN has to put you somewhere valid.
      if (id === threadId) onPick(null);
      refresh();
    },
    onError: () => toast.error('Could not delete the conversation'),
  });

  async function confirmDelete(t: ThreadSummary) {
    /*
     * #359's outstanding acceptance criterion, landing here.
     *
     * Deleting a thread does NOT undo what it did, and the backend deliberately
     * reverses nothing — the conversation is private but its consequences are
     * shared workspace state. Someone deleting a thread to "undo the mess" would
     * otherwise be doing the one thing that cannot help, and would believe it
     * had.
     */
    const ok = await confirm({
      title: `Delete "${t.title}"?`,
      message:
        'This removes the conversation only. Anything Tyron actually did — records it created, ' +
        'fields it changed — stays exactly as it is, and deleting this will not undo any of it.',
      confirmLabel: 'Delete conversation',
      danger: true,
    });
    if (ok) remove.mutate(t.id);
  }

  return (
    <span className="relative flex items-center gap-0.5">
      <button
        type="button"
        aria-label="New conversation"
        title="New conversation"
        onClick={() => {
          // Starting a new one must not discard the old one — it is a thread on
          // the server the moment it has a message, and this only forgets which
          // one we were in.
          onPick(null);
          setOpen(false);
        }}
        className="rounded p-1.5 text-muted hover:bg-hover hover:text-ink"
      >
        <MessageSquarePlus className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Past conversations"
        title="Past conversations"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn('rounded p-1.5 text-muted hover:bg-hover hover:text-ink', open && 'bg-hover text-ink')}
      >
        <History className="h-4 w-4" />
      </button>

      {open && (
        <>
          {/* Click-away. A menu that only closes via its own button strands the
              user when they click into the conversation behind it. */}
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-40 mt-1 max-h-80 w-72 overflow-auto rounded-[var(--radius-card)] border border-border-default bg-card py-1 shadow-[0_4px_12px_rgba(15,23,41,0.15)]">
            {threads.isLoading && <p className="px-3 py-2 text-[12px] text-faint">Loading…</p>}
            {threads.isError && <p className="px-3 py-2 text-[12px] text-error">Could not load conversations.</p>}
            {threads.data?.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-faint">No earlier conversations yet.</p>
            )}
            {threads.data?.map((t) => (
              <div
                key={t.id}
                className={cn(
                  'group flex items-center gap-1 px-2 py-1.5 text-[13px] hover:bg-hover',
                  t.id === threadId && 'bg-hover',
                )}
              >
                {renaming === t.id ? (
                  <input
                    autoFocus
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && draftTitle.trim()) {
                        rename.mutate({ id: t.id, title: draftTitle.trim() });
                        setRenaming(null);
                      }
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-border-strong bg-card px-1 py-0.5 text-[13px] focus:outline-none"
                    aria-label="Conversation title"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onPick(t.id);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 truncate text-left text-ink"
                    title={t.title}
                  >
                    {t.title || 'Untitled conversation'}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Rename ${t.title}`}
                  onClick={() => {
                    setRenaming(t.id);
                    setDraftTitle(t.title);
                  }}
                  className="shrink-0 rounded px-1 text-faint opacity-0 hover:text-ink group-hover:opacity-100"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${t.title}`}
                  onClick={() => void confirmDelete(t)}
                  className="shrink-0 rounded px-1 text-faint opacity-0 hover:text-error group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
