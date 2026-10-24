'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { connectionWords, lastUsedText, useAiConnections, useDisconnectAiConnection } from '@/lib/ai-connections';
import type { AiConnection } from '@/lib/ai-connections';
import { useDateFormat } from '@/lib/preferences';

export type AiConnectionsView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: AiConnection[]; busyId: string | null };

/** Presentational: every state is a value, so every state has a test. */
export function AiConnectionsList({
  view,
  date,
  onDisconnect,
}: {
  view: AiConnectionsView;
  date: (v: unknown) => string;
  onDisconnect: (c: AiConnection) => void;
}) {
  if (view.kind === 'loading') {
    return (
      <p role="status" className="text-body text-muted">
        Loading…
      </p>
    );
  }
  if (view.kind === 'error') {
    return (
      <p role="alert" className="text-body text-error">
        Could not load your connected AI clients. Try again in a moment.
      </p>
    );
  }
  if (view.items.length === 0) {
    return <p className="text-body text-muted">No AI client is connected to your account.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {view.items.map((c) => {
        const words = connectionWords(c);
        const busy = view.busyId === c.id;
        return (
          <li
            key={c.id}
            className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-border-default bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate text-prose font-semibold text-ink">{c.client_name}</p>
              <p className="text-label text-muted">
                {words.how} · {words.reaches}
              </p>
              <p className="text-label text-muted">
                {c.connected_at ? `Connected ${date(c.connected_at)}` : 'Connection date not recorded'} · {lastUsedText(c, date)}
              </p>
            </div>
            <Button
              size="sm"
              variant="destructive"
              className="self-start sm:self-center"
              disabled={view.busyId !== null}
              aria-label={`Disconnect ${c.client_name}`}
              onClick={() => onDisconnect(c)}
            >
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** The AI clients you have connected, with a way to cut each one off. Mounted on Connect your AI. */
export function AiConnectionsSection({ ws }: { ws: string }) {
  const list = useAiConnections(ws);
  const disconnect = useDisconnectAiConnection(ws);
  const confirm = useConfirm();
  const fmt = useDateFormat();

  const view: AiConnectionsView = list.isPending
    ? { kind: 'loading' }
    : list.isError
      ? { kind: 'error' }
      : { kind: 'ready', items: list.data, busyId: disconnect.isPending ? (disconnect.variables ?? null) : null };

  async function onDisconnect(c: AiConnection) {
    const words = connectionWords(c);
    const ok = await confirm({
      title: words.confirmTitle,
      message: words.confirmMessage,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (ok) disconnect.mutate(c.id);
  }

  return (
    <section aria-labelledby="ai-connections-title" className="mt-6">
      <h2 id="ai-connections-title" className="mb-2 text-label font-semibold uppercase tracking-[0.06em] text-muted">
        Connected AI clients
      </h2>
      <AiConnectionsList view={view} date={fmt.date} onDisconnect={(c) => void onDisconnect(c)} />
    </section>
  );
}
