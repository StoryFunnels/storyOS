'use client';

import { useState } from 'react';
import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { useDatabases, useSpaces } from '@/lib/queries';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  NO_CREDENTIAL_WORDS,
  chainOf,
  describeAction,
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
 * credential says so on its row, in words (`NO_CREDENTIAL_WORDS`); it is never drawn as a chain with a blank link.
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

  if (log.isLoading) return <p className="text-body text-muted">Loading…</p>;
  if (log.isError) return <p className="text-body text-ink">The recent actions could not be loaded.</p>;
  if (rows.length === 0) {
    return <p className="text-body text-muted">No agent or token has changed anything in the last 30 days.</p>;
  }

  return (
    <>
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default">
        {rows.map((r) => {
          const credential = credentialOf(r.credential_id);
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpen(r)}
              className="flex w-full flex-col gap-0.5 border-b border-border-default px-3 py-2 text-left last:border-b-0 hover:bg-hover"
            >
              <span className="text-body text-ink">{describeAction(r)}</span>
              <span className="text-label text-ink-secondary">
                {r.credential_id
                  ? `${credential ? credential.name : 'A credential'}${credential?.revoked_at ? ' (revoked)' : ''}`
                  : 'No credential recorded'}
                {r.agent_name ? ` · agent ${r.agent_name}` : ''}
                {r.actor_name ? ` · for ${r.actor_name}` : ''}
                {` · ${dateTime(r.created_at)}`}
              </span>
              {!r.credential_id && <span className="text-label text-muted">{NO_CREDENTIAL_WORDS}</span>}
            </button>
          );
        })}
      </div>
      {log.hasNextPage && (
        <button
          type="button"
          className="mt-2 text-label text-ink-secondary underline hover:text-ink"
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
