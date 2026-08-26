'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AgentAvatar } from './agent-avatar';

/**
 * The conversation inside Tyron's panel (#357c).
 *
 * One thread, opened lazily on first use — a thread is created when the user
 * actually says something, not when the panel opens, so browsing the panel does
 * not litter the list with empties (#359: nothing may be called "Untitled", and
 * a thread with no messages has nothing to be named from).
 */

interface Msg {
  id: string;
  role: string;
  content: string;
}

export function TyronConversation({ ws }: { ws: string }) {
  const qc = useQueryClient();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  const thread = useQuery({
    queryKey: ['tyron-thread', ws, threadId],
    enabled: Boolean(threadId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/tyron/threads/{thread}', {
        params: { path: { ws, thread: threadId! } },
      } as never);
      if (error) throw error;
      return data as unknown as { id: string; title: string; messages: Msg[] };
    },
  });

  const send = useMutation({
    mutationFn: async (message: string) => {
      // Create the thread on the FIRST message, so it can be auto-named from it.
      let id = threadId;
      if (!id) {
        const { data, error } = await api.POST('/api/v1/workspaces/{ws}/tyron/threads', {
          params: { path: { ws } },
          body: { first_message: message } as never,
        } as never);
        if (error) throw error;
        id = (data as unknown as { id: string }).id;
        setThreadId(id);
      }
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/tyron/threads/{thread}/turns', {
        params: { path: { ws, thread: id } },
        body: { message } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { reply: string; question?: { message: string; tool: string } };
    },
    /*
      `onSettled`, not `onSuccess`. The user's message is persisted before the
      turn can fail, so a FAILED turn still changed the thread — refetching only
      on success left the message invisible until a reload, which is how the
      composer appeared to swallow it.
    */
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tyron-thread', ws] }),
  });

  /**
   * #357d — answering the question. Sends only a boolean: the pending call is
   * held server-side, so this cannot authorise something other than what was
   * shown.
   */
  const confirm = useMutation({
    mutationFn: async (approve: boolean) => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/tyron/threads/{thread}/confirm',
        { params: { path: { ws, thread: threadId! } }, body: { approve } as never } as never,
      );
      if (error) throw error;
      return data as unknown as { reply: string };
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tyron-thread', ws] }),
  });

  // The question stands until it is answered. Cleared once a confirm succeeds,
  // and replaced if a later turn asks something new.
  const question = confirm.isSuccess ? undefined : send.data?.question;

  const messages = thread.data?.messages ?? [];

  // Keep the newest turn in view. `send.isPending` is in the deps so the
  // "working" row scrolls into view too — otherwise the spinner appears below
  // the fold and the panel looks frozen.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, send.isPending]);

  const submit = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    send.mutate(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {messages.length === 0 && !send.isPending && (
          <p className="text-[13px] text-muted">
            Ask about your data, or tell me what to change.
          </p>
        )}
        <div className="flex flex-col gap-4">
          {messages.map((m) => (
            <div key={m.id} className="flex gap-2">
              {m.role === 'assistant' ? (
                <AgentAvatar name="Tyron" size="sm" className="mt-0.5" />
              ) : (
                <span className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              )}
              <p
                className={cn(
                  'min-w-0 whitespace-pre-wrap text-[13px]',
                  m.role === 'assistant' ? 'text-ink' : 'text-ink-secondary',
                )}
              >
                {m.content}
              </p>
            </div>
          ))}
          {send.isPending && (
            /* #357: an animation while working, then a plain statement of what
               changed. No step-by-step log — the pulse IS the progress. */
            <div className="flex items-center gap-2">
              <AgentAvatar name="Tyron" size="sm" />
              <span className="flex gap-1" aria-label="Tyron is working">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </span>
            </div>
          )}
          {question && !confirm.isPending && (
            /*
              #358's confirmation, made answerable. The destructive choice is NOT
              the default-looking button: "Yes, do it" carries the danger colour
              and Cancel is the quiet one, so the safe action is the easy one.
            */
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-hover p-2">
              <span className="min-w-0 flex-1 text-[13px] text-ink">{question.message}</span>
              <button
                type="button"
                onClick={() => confirm.mutate(false)}
                className="rounded-[var(--radius-control)] px-2 py-1 text-[12px] text-muted hover:bg-active hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => confirm.mutate(true)}
                className="rounded-[var(--radius-control)] bg-error px-2 py-1 text-[12px] font-medium text-[var(--on-accent,#fff)]"
              >
                Yes, do it
              </button>
            </div>
          )}
          {confirm.isError && (
            <p className="text-[13px] text-error">
              {apiErrorMessage(confirm.error, "I couldn't finish that just now.")}
            </p>
          )}
          {send.isError && (
            <p className="text-[13px] text-error">
              {/*
                `apiErrorMessage` — the SHARED helper, not a hand-rolled reader.
                The first version of this checked `err.message`, which is not
                where a StoryOS API error lives: the body is
                `{error:{message,details}}`, so it always fell through to the
                generic fallback and hid the real reason. That is #373 exactly —
                "the failure message hides the reason the server already sent" —
                reintroduced in a new file within a day of closing it. The
                existing helper is the answer, and the reason it exists.
              */}
              {apiErrorMessage(send.error, "I couldn't finish that just now.")}
            </p>
          )}
        </div>
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-border-default p-3">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line — the convention every
              // chat composer uses, so it needs no teaching.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask Tyron…"
            aria-label="Message Tyron"
            className="max-h-32 min-h-8 flex-1 resize-none rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || send.isPending}
            aria-label="Send"
            className="shrink-0 rounded-[var(--radius-control)] bg-[var(--accent)] p-1.5 text-[var(--on-accent,#fff)] disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
