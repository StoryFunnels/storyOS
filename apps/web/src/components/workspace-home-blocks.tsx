'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Bot, CheckCheck, Database as DatabaseIcon, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { useFavorites } from '@/components/sidebar';
import { useDateFormat } from '@/lib/preferences';
import { actionKindLabel, runStatusLabel } from '@/lib/run-labels';

/**
 * #723 — what an established workspace sees on its home page.
 *
 * WORKSPACE-SCOPED, NOT PERSON-SCOPED, which is the whole reason this exists
 * rather than redirecting to /w/[ws]/me. `/me` already answers "what should I
 * do next"; a second surface answering the same question would be one concept
 * living in two places that must agree — the shape of the bug #713 and #718
 * were both filed for. These blocks answer what no other surface can: what is
 * waiting on A human (not necessarily you), what the agents have been doing,
 * and where to go.
 *
 * WHY NOT A WORKSPACE ACTIVITY FEED, the obvious fourth block: there is no
 * workspace-wide record feed a non-admin can read. `audit-log.controller.ts`
 * is @MinRole('admin') at controller level, per #454's own AC ("a non-admin
 * member cannot reach the audit view or its API"), and every other feed is
 * record- or database-scoped. Widening one would contradict a shipped access
 * decision, so #723 puts it out of scope rather than quietly reaching for it.
 */

interface ApprovalRow {
  id: string;
  preview_text: string | null;
  status: string;
  created_at: string;
  action_snapshot: { kind?: string } | null;
}

interface RunRow {
  id: string;
  name: string | null;
  status: string;
  error: string | null;
  started_at: string;
}

interface FavoriteRow {
  target_type: 'record' | 'database';
  target_id: string;
  title: string;
  database_id?: string;
}

const SECTION = 'text-[11px] font-semibold uppercase tracking-wider text-muted';
const CARD = 'rounded-[var(--radius-card)] border border-border-default bg-card';
const ROW = 'flex items-start gap-2 p-3';

/** Pending approvals across the whole workspace — returns a bare array. */
function usePendingApprovals(ws: string) {
  return useQuery({
    queryKey: ['home-approvals', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/approvals', {
        params: { path: { ws }, query: { status: 'pending' } },
      } as never);
      if (error) throw error;
      return data as unknown as ApprovalRow[];
    },
  });
}

/** Recent automation runs, newest first (the endpoint wraps its rows in `data`). */
function useRecentRuns(ws: string) {
  return useQuery({
    queryKey: ['home-runs', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/runs', {
        params: { path: { ws }, query: { limit: 20 } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: RunRow[] }).data;
    },
  });
}

function favoriteHref(ws: string, f: FavoriteRow): string {
  return f.target_type === 'record'
    ? `/w/${ws}/d/${f.database_id}/r/${f.target_id}`
    : `/w/${ws}/d/${f.target_id}`;
}

export function WorkspaceHomeBlocks({
  ws,
  databases,
}: {
  ws: string;
  databases: Array<{ id: string; name: string }>;
}) {
  const approvals = usePendingApprovals(ws);
  const runs = useRecentRuns(ws);
  const favorites = useFavorites(ws);
  const fmt = useDateFormat();

  const pending = approvals.data ?? [];
  const allRuns = runs.data ?? [];
  const isBad = (r: RunRow) => r.status === 'failed' || Boolean(r.error);
  // Failures first. A failed run is the reason anyone opens this block, and
  // letting it sort by time is how it scrolls off behind twenty green ones.
  const recent = [...allRuns.filter(isBad), ...allRuns.filter((r) => !isBad(r))].slice(0, 5);
  const favs = (favorites.data ?? []) as FavoriteRow[];

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className={SECTION}>Needs a decision{pending.length > 0 ? ` · ${pending.length}` : ''}</p>
          {pending.length > 0 && (
            <Link href={`/w/${ws}/runs`} className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline">
              Review
            </Link>
          )}
        </div>
        {/* Deliberately not the Inbox. The Inbox is fed by /notifications, so it
            shows approvals routed to YOU; this is every pending approval in the
            workspace, including ones waiting on someone who is on holiday —
            which a personal inbox structurally cannot show. */}
        <div className={`${CARD} divide-y divide-border-default`}>
          {pending.length === 0 ? (
            <p className={`${ROW} text-[13px] text-muted`}>
              <CheckCheck className="mt-0.5 h-4 w-4 shrink-0" />
              Nothing is waiting on a person.
            </p>
          ) : (
            pending.slice(0, 5).map((a) => (
              <div key={a.id} className={ROW}>
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">
                    {a.preview_text || actionKindLabel(a.action_snapshot?.kind)}
                  </span>
                  <span className="block text-[12px] text-muted">waiting since {fmt.date(a.created_at)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className={SECTION}>Agent runs</p>
          {/* Both blocks drop their link when empty: sending someone to an
              empty page is a dead end, and one block keeping its link while
              its neighbour loses it reads as a bug. */}
          {recent.length > 0 && (
            <Link href={`/w/${ws}/runs`} className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline">
              All runs
            </Link>
          )}
        </div>
        <div className={`${CARD} divide-y divide-border-default`}>
          {recent.length === 0 ? (
            <p className={`${ROW} text-[13px] text-muted`}>
              <Bot className="mt-0.5 h-4 w-4 shrink-0" />
              No agent runs yet.
            </p>
          ) : (
            recent.map((r) => {
              const bad = isBad(r);
              return (
                <div key={r.id} className={ROW}>
                  <Bot className={`mt-0.5 h-4 w-4 shrink-0 ${bad ? 'text-error' : 'text-muted'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{r.name || 'Automation'}</span>
                    <span className={`block truncate text-[12px] ${bad ? 'text-error' : 'text-muted'}`}>
                      {bad ? r.error || runStatusLabel(r.status) : runStatusLabel(r.status)} · {fmt.dateTime(r.started_at)}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <p className={SECTION}>Where to go</p>
        {favs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {favs.slice(0, 8).map((f) => (
              <Link
                key={`${f.target_type}:${f.target_id}`}
                href={favoriteHref(ws, f)}
                className="flex items-center gap-1 rounded-[var(--radius-chip)] border border-border-default bg-card px-2 py-1 text-[12px] text-ink hover:bg-hover"
              >
                <Star className="h-3 w-3 shrink-0 fill-[var(--accent)] text-[var(--accent)]" />
                <span className="max-w-[16rem] truncate">{f.title}</span>
              </Link>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {databases.map((d) => (
            <Link
              key={d.id}
              href={`/w/${ws}/d/${d.id}`}
              className={`${CARD} flex items-center gap-2 p-3 text-[13px] text-ink hover:bg-hover`}
            >
              <DatabaseIcon className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
