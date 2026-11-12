'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bot, CheckCheck, Star } from 'lucide-react';
import { DatabaseGlyph } from '@/components/database-glyph';
import { buildDatabaseCards } from '@/lib/home-database-cards';
import type { DatabaseSummary, Space } from '@/lib/queries';
import { api } from '@/lib/api';
import { useFavorites } from '@/components/sidebar';
import { useDateFormat } from '@/lib/preferences';
import { actionKindLabel, runStatusLabel } from '@/lib/run-labels';
import { useAgents } from '@/lib/runners/queries';
import { reviewState, reviewTitle, showAutomationRuns } from '@/lib/home-blocks';

/**
 * #723 — the work blocks on the workspace home page. Ticket #1274: they are no longer gated on an "established"
 * workspace. Review (approvals) always shows; Automation runs shows once an agent exists (see lib/home-blocks.ts).
 *
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

/** Ticket #1274 — ONE block title for the whole page (this file and the getting-started card): 14px/700, sentence case, ink. */
export const BLOCK_TITLE = 'm-0 text-[14px] font-bold leading-[17px] text-ink';
/** A block is a white card: radius 6, padding 14, hairline border (the prototype's). */
export const BLOCK_CARD = 'rounded-[var(--radius-card)] border border-border-default bg-card p-[14px]';
const ROW = 'flex items-start gap-2 py-2';
const LINK = 'text-label text-muted underline-offset-2 hover:text-ink hover:underline';
/** "Where to go" rows: 30px, 13px text, radius 5, padding 7px 6px. */
const GO_ROW = 'flex h-[30px] items-center gap-2 rounded-[var(--radius-control)] px-1.5 py-[7px] text-[13px] text-ink hover:bg-hover';

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
  spaces,
  onStartNew,
}: {
  ws: string;
  databases: ReadonlyArray<Pick<DatabaseSummary, 'id' | 'name' | 'icon' | 'color' | 'spaceId'>>;
  spaces: ReadonlyArray<Pick<Space, 'id' | 'name'>>;
  /** Present when the viewer may install templates: the last row of "Where to go". */
  onStartNew?: () => void;
}) {
  const approvals = usePendingApprovals(ws);
  const runs = useRecentRuns(ws);
  const favorites = useFavorites(ws);
  const agents = useAgents(ws);
  const fmt = useDateFormat();

  const review = reviewState({ isPending: approvals.isPending, isError: approvals.isError, data: approvals.data });
  const pending = approvals.data ?? [];
  const showRuns = showAutomationRuns({ loading: agents.loading, error: agents.error, agentCount: agents.agents.length });
  const allRuns = runs.data ?? [];
  const isBad = (r: RunRow) => r.status === 'failed' || Boolean(r.error);
  // Failures first. A failed run is the reason anyone opens this block, and
  // letting it sort by time is how it scrolls off behind twenty green ones.
  const recent = [...allRuns.filter(isBad), ...allRuns.filter((r) => !isBad(r))].slice(0, 5);
  const favs = (favorites.data ?? []) as FavoriteRow[];
  const cards = buildDatabaseCards(databases, spaces);

  return (
    <div className="mt-6 flex flex-col gap-3" data-testid="home-blocks">
      <section className={BLOCK_CARD} data-testid="home-review">
        <div className="mb-1 flex items-center justify-between">
          <h2 className={BLOCK_TITLE}>{reviewTitle(review)}</h2>
          {review.kind === 'some' && (
            <Link href={`/w/${ws}/runs`} className={LINK}>
              See all
            </Link>
          )}
        </div>
        {/* Deliberately not the Inbox. The Inbox is fed by /notifications, so it
            shows approvals routed to YOU; this is every pending approval in the
            workspace, including ones waiting on someone who is on holiday —
            which a personal inbox structurally cannot show. */}
        <div className="divide-y divide-border-default">
          {review.kind === 'unknown' ? (
            <p className={`${ROW} m-0 text-body text-muted`} data-testid="home-review-unknown">
              <span aria-hidden="true">—</span>
              <span className="sr-only">Approvals could not be counted yet.</span>
            </p>
          ) : review.kind === 'none' ? (
            <p className={`${ROW} m-0 text-body text-muted`}>
              <CheckCheck className="mt-0.5 h-4 w-4 shrink-0" />
              Nothing is waiting on a person.
            </p>
          ) : (
            pending.slice(0, 5).map((a) => (
              <div key={a.id} className={ROW}>
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink">
                    {a.preview_text || actionKindLabel(a.action_snapshot?.kind)}
                  </span>
                  <span className="block text-label text-muted">waiting since {fmt.date(a.created_at)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {showRuns && (
        <section className={BLOCK_CARD} data-testid="home-runs">
          <div className="mb-1 flex items-center justify-between">
            <h2 className={BLOCK_TITLE}>Automation runs</h2>
            {recent.length > 0 && (
              <Link href={`/w/${ws}/runs`} className={LINK}>
                All runs
              </Link>
            )}
          </div>
          <div className="divide-y divide-border-default">
            {runs.isError ? (
              <p className={`${ROW} m-0 text-body text-muted`}>
                <span aria-hidden="true">—</span>
                <span className="sr-only">Runs could not be loaded.</span>
              </p>
            ) : recent.length === 0 ? (
              <p className={`${ROW} m-0 text-body text-muted`}>
                <Bot className="mt-0.5 h-4 w-4 shrink-0" />
                No automation runs yet.
              </p>
            ) : (
              recent.map((r) => {
                const bad = isBad(r);
                return (
                  <div key={r.id} className={ROW}>
                    <Bot className={`mt-0.5 h-4 w-4 shrink-0 ${bad ? 'text-error' : 'text-muted'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-ink">{r.name || 'Automation'}</span>
                      <span className={`block truncate text-label ${bad ? 'text-error' : 'text-muted'}`}>
                        {bad ? r.error || runStatusLabel(r.status) : runStatusLabel(r.status)} · {fmt.dateTime(r.started_at)}
                      </span>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}

      {(cards.length > 0 || favs.length > 0 || onStartNew) && (
        <section className={BLOCK_CARD} data-testid="home-where-to-go">
          <h2 className={`${BLOCK_TITLE} mb-1`}>Where to go</h2>
          <div className="flex flex-col">
            {favs.slice(0, 8).map((f) => (
              <Link key={`${f.target_type}:${f.target_id}`} href={favoriteHref(ws, f)} className={GO_ROW}>
                <Star className="h-3.5 w-3.5 shrink-0 fill-primary-text text-primary-text" />
                <span className="min-w-0 flex-1 truncate">{f.title}</span>
              </Link>
            ))}
            {cards.map((d) => (
              <Link key={d.id} href={`/w/${ws}/d/${d.id}`} title={d.label} className={GO_ROW}>
                {/* The sidebar's own glyph component: icon and colour come from the database, not from this row. */}
                <DatabaseGlyph icon={d.icon} color={d.color} id={d.id} />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {d.spaceName && <span className="max-w-[40%] shrink-0 truncate text-label text-muted">{d.spaceName}</span>}
              </Link>
            ))}
            {onStartNew && (
              <button type="button" className={`${GO_ROW} w-full text-left text-muted`} onClick={onStartNew}>
                Start something new →
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
