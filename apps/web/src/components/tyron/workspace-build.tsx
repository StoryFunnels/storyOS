'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import { useTyronPanel } from '@/lib/tyron-panel';

interface DatabaseSummary {
  id: string;
  name: string;
  isSystem?: boolean;
}

/**
 * "Describe your business, get a workspace" (#363).
 *
 * The reason this epic exists — everything else is a good assistant, this is the
 * thing that answers "why should I use a database at all" by handing someone
 * theirs.
 *
 * ## Progress comes from WATCHING THE WORKSPACE, not from a streamed log
 *
 * `POST /tyron/threads/:id/build` is one long request — tens of seconds — and
 * returns a single reply at the end. That is deliberate: #357 forbids surfacing
 * a tool trace, and streaming the steps would be exactly that.
 *
 * So the tick-list is built by polling the databases list while the build runs.
 * What the user sees is OUTCOMES ACCUMULATING — "Clients ✓, Projects ✓" — which
 * is what the AC asks for, and it is honest in a way a log would not be: a name
 * appears here only once the database really exists.
 *
 * The 1.5s interval is chosen against the AC's "no silent gap longer than a
 * couple of seconds", not against server load — a build is a handful of requests
 * over half a minute.
 */
const POLL_MS = 1500;

export function WorkspaceBuild({
  ws,
  ensureThread,
  onBuilt,
}: {
  ws: string;
  /**
   * Creates the thread if there is not one yet, and returns its id.
   *
   * A build is almost always someone's FIRST message, so there is no thread to
   * post to — passing a raw id here would 404 on the one path this feature
   * exists for. The thread is also what makes the result reshapeable
   * afterwards ("actually call them Clients"), which is an acceptance criterion,
   * so it has to be a real thread rather than a fire-and-forget call.
   */
  ensureThread: (firstMessage: string) => Promise<string>;
  onBuilt: () => void;
}) {
  const qc = useQueryClient();
  const { set: setPanel } = useTyronPanel();
  const [description, setDescription] = useState('');
  const [building, setBuilding] = useState(false);
  const startedWith = useRef<Set<string>>(new Set());

  const databases = useQuery({
    queryKey: ['databases', ws],
    // Only while a build is running. Polling a settled workspace forever would
    // be a background request nobody asked for.
    refetchInterval: building ? POLL_MS : false,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases', { params: { path: { ws } } });
      if (error) throw error;
      return data as unknown as DatabaseSummary[];
    },
  });

  const build = useMutation({
    mutationFn: async (text: string) => {
      // Snapshot BEFORE, so the tick-list shows what this build made rather than
      // what the workspace already had. Reshaping an existing workspace is a
      // legitimate second use of this, and it must not claim credit for the
      // databases that were already there.
      startedWith.current = new Set((databases.data ?? []).map((d) => d.id));
      /*
       * #363 — a build runs in FULL: the whole window, sidebar hidden.
       *
       * The one moment where taking the entire screen is right, because there is
       * nothing to look at beside it yet. Entered on SUBMIT rather than when the
       * offer appears — taking over the screen before the user has committed to
       * anything would be the jarring version, and `useTyronPanel.open()`
       * deliberately never restores into full for the same reason.
       *
       * Not exited automatically. "Leaving full afterwards reveals the built
       * workspace already in place" is the AC, and leaving is the user's move —
       * yanking the screen back the instant a build finishes would deny them the
       * summary they just waited half a minute for.
       */
      setPanel('full');
      setBuilding(true);
      const thread = await ensureThread(text);
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/tyron/threads/{thread}/build', {
        params: { path: { ws, thread } },
        body: { description: text } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { reply: string };
    },
    onSettled: () => {
      setBuilding(false);
      // The sidebar and every database list must show the new work immediately —
      // "leaving full reveals the built workspace already in place" (AC2).
      void qc.invalidateQueries({ queryKey: ['databases', ws] });
      void qc.invalidateQueries({ queryKey: ['spaces', ws] });
      void qc.invalidateQueries({ queryKey: ['tyron-thread', ws] });
      onBuilt();
    },
  });

  // Keep the poll honest if the request dies without settling.
  useEffect(() => {
    if (!build.isPending && building) setBuilding(false);
  }, [build.isPending, building]);

  const created = (databases.data ?? []).filter((d) => !d.isSystem && !startedWith.current.has(d.id));

  if (build.isPending || created.length > 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
        <p className="flex items-center gap-2 text-[13px] text-ink">
          {build.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-muted" aria-hidden />
              {/* A plain progress line, not a tool trace (#363). */}
              <span>Building your workspace…</span>
            </>
          ) : (
            <span className="font-medium">Here is what I built.</span>
          )}
        </p>
        {created.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5" aria-label="What exists so far">
            {created.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-[13px] text-muted">
                <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                <span className="truncate">{d.name}</span>
              </li>
            ))}
          </ul>
        )}
        {build.isPending && (
          <p className="mt-3 text-[12px] text-faint">
            This takes half a minute or so. You can correct anything afterwards just by asking.
          </p>
        )}
        {build.isError && (
          <p className="mt-3 text-[12px] text-error">
            {/*
              #357's stop-and-report: a part-way failure leaves a COHERENT
              workspace, and the tick-list above is exactly what did get made —
              so the error names the failure without implying nothing happened.
            */}
            {apiErrorMessage(build.error, 'The build stopped part-way.')} Anything listed above was created and is yours to keep.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
      <p className="text-[13px] font-medium text-ink">Tell me what you do.</p>
      <p className="mt-1 text-[12px] text-muted">
        One sentence is enough. I&rsquo;ll set up databases that fit, connect them, and add the views worth having.
      </p>
      <textarea
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && description.trim()) {
            e.preventDefault();
            build.mutate(description.trim());
          }
        }}
        placeholder="We run a small design studio — client projects, invoices, and a content calendar."
        aria-label="Describe your business"
        className="mt-3 w-full resize-none rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-[var(--accent)] focus:outline-none"
      />
      <button
        type="button"
        disabled={!description.trim()}
        onClick={() => build.mutate(description.trim())}
        className="mt-2 rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-[var(--on-accent,#fff)] disabled:opacity-40"
      >
        Build my workspace
      </button>
    </div>
  );
}
