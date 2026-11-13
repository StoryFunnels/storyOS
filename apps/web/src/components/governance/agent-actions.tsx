'use client';

import { useState } from 'react';
import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { useDatabases, useSpaces } from '@/lib/queries';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Rocket } from 'lucide-react';
import {
  actionMeta,
  actionSubject,
  chainOf,
  describeAction,
  missingCredentialNote,
  isAgentAction,
  type AuditEventRow,
  type CredentialDto,
} from '@/lib/governance';

/**
 * Ticket #934 — the Governance screen's list of recent agent actions, each with the credential that performed it and the member it
 * ran as, and a drill-down with the FULL chain. Read-only and admin-only (the endpoints are; the page gates on the role too).
 *
 * Everything comes from what ticket #882 stamps on a write (the credential) and ticket #541 (the agent, and the member) through
 * ONE read, the audit log filtered to agents and tokens — there is no second provenance store here. An action with no recorded
 * credential says so ONCE above the list (`NO_CREDENTIAL_NOTE`) and in its own chain (`NO_CREDENTIAL_WORDS`); it is never drawn as a chain with a blank link.
 * Each row leads with who acted (the agent), a gold mark because an agent acted (ticket #1163), then what it did in words (ticket #1284).
 */
const PAGE = 25;

export function AgentActions({ ws }: { ws: string }) {
  const { dateTime } = useDateFormat();
  const [open, setOpen] = useState<AuditEventRow | null>(null);
  const databases = useDatabases(ws);
  const spaces = useSpaces(ws);

  const log = useInfiniteQuery({
    queryKey: ['governance-agent-actions', ws],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string | number> = { source: 'agent,mcp', limit: PAGE };
      if (pageParam) query.cursor = pageParam;
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/audit-log', { params: { path: { ws }, query } } as never);
      if (error) throw error;
      return data as unknown as { data: AuditEventRow[]; next_cursor: string | null; has_more: boolean };
    },
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
  });
  const rows = (log.data?.pages ?? []).flatMap((p) => p.data).filter(isAgentAction);

  // One credential lookup per DISTINCT credential on screen — a handful, not one per row.
  const credentialIds = [...new Set(rows.map((r) => r.credential_id).filter((id): id is string => Boolean(id)))];
  const credentials = useQueries({
    queries: credentialIds.map((id) => ({
      queryKey: ['governance-credential', ws, id],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/v1/workspaces/{ws}/credentials/{id}' as never, { params: { path: { ws, id } } } as never);
        if (error) throw error;
        return data as unknown as CredentialDto;
      },
      staleTime: 60_000,
    })),
  });
  const credentialOf = (id: string | null | undefined): CredentialDto | null | undefined =>
    id ? credentials[credentialIds.indexOf(id)]?.data : undefined;

  const names = {
    space: (id: string) => (spaces.data ?? []).find((s) => s.id === id)?.name ?? null,
    database: (id: string) => (databases.data ?? []).find((d) => d.id === id)?.name ?? null,
  };

  if (log.isLoading) return <p className="px-3.5 py-3 text-body text-muted">Loading…</p>;
  if (log.isError) return <p className="px-3.5 py-3 text-body text-ink">The recent actions could not be loaded.</p>;
  if (rows.length === 0) {
    return <p className="px-3.5 py-3 text-body text-muted">No agent or token has changed anything in the last 30 days.</p>;
  }

  const note = missingCredentialNote(rows);
  return (
    <>
      {note && <p className="border-b border-border-default px-3.5 py-2.5 text-label text-muted">{note}</p>}
      <div>
        {rows.map((r) => {
          const credential = credentialOf(r.credential_id);
          const meta = actionMeta(r, credential);
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpen(r)}
              className="flex w-full items-start gap-2.5 border-b border-border-default px-3.5 py-2.5 text-left last:border-b-0 hover:bg-hover"
            >
              <span
                aria-hidden
                className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] text-accent-text"
              >
                <Rocket className="h-3.5 w-3.5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <b className="min-w-0 truncate font-semibold text-ink">{actionSubject(r, credential)}</b>
                  <span className="ml-auto shrink-0 text-label text-muted">{dateTime(r.created_at)}</span>
                </span>
                <span className="text-body text-ink">
                  {describeAction(r)}
                  {meta && <span className="text-label text-ink-secondary">{` · ${meta}`}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {log.hasNextPage && (
        <button
          type="button"
          className="mx-3.5 mb-3 mt-2 text-label text-ink-secondary underline hover:text-ink"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Show older actions'}
        </button>
      )}
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent title="Who did this, and on whose authority">
            <dl className="flex flex-col gap-2.5">
              {chainOf(open, credentialOf(open.credential_id), names, dateTime).map((s) => (
                <div key={s.label} className="flex flex-col gap-0.5">
                  <dt className="text-label text-ink-secondary">{s.label}</dt>
                  <dd className={s.absent ? 'text-body text-muted' : 'text-body text-ink'}>{s.value}</dd>
                </div>
              ))}
            </dl>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
