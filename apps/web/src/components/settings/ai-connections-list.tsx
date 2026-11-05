'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { SettingsBox, SettingsPill, SettingsRow } from '@/components/settings/settings-chrome';
import { ClientLogo } from '@/components/connect-ai-logos';
import {
  aiAppsSummary,
  canReconnect,
  clientFor,
  connectionState,
  connectionWords,
  lastUsedText,
  useAiConnections,
  useDisconnectAiConnection,
} from '@/lib/ai-connections';
import type { AiConnection } from '@/lib/ai-connections';
import { useDateFormat } from '@/lib/preferences';

export type AiConnectionsView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: AiConnection[]; busyId: string | null };

/**
 * The words under a row's name (ticket #1187, the prototype's): what is wrong for a broken one, what it reaches for the rest, since
 * when. A token says it is one; an OAuth app's "last use" is never recorded, and says so rather than staying silent.
 */
export function connectionLine(c: AiConnection, date: (v: unknown) => string): string {
  const when = c.connected_at ? `connected ${date(c.connected_at)}` : 'connection date not recorded';
  if (connectionState(c).kind === 'needs_reconnect') return `Can’t reach StoryOS until it is reconnected · ${when}`;
  const words = connectionWords(c);
  const reach =
    c.kind === 'token'
      ? `${words.how} · ${words.reaches}`
      : c.reaches === 'all_workspaces'
        ? 'Reaches all your workspaces'
        : c.reaches === 'one_workspace' && c.approved
          ? `Reaches one workspace${c.approved.workspace_name ? ` · ${c.approved.workspace_name}` : ''}`
          : words.reaches;
  return `${reach} · ${when} · ${lastUsedText(c, date).replace(/^Last/, 'last')}`;
}

/** Presentational: every state is a value, so every state has a test. */
export function AiConnectionsList({
  view,
  date,
  onDisconnect,
  onReconnect,
  reconnectingId = null,
  panel,
}: {
  view: AiConnectionsView;
  date: (v: unknown) => string;
  onDisconnect: (c: AiConnection) => void;
  /** Opens the Reconnect steps for one connection. Offered only where `canReconnect` says the data supports it. */
  onReconnect?: (c: AiConnection) => void;
  reconnectingId?: string | null;
  /** What opens under the row whose Reconnect is open. */
  panel?: (c: AiConnection) => ReactNode;
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
    <SettingsBox title="AI apps" aside={aiAppsSummary(view.items)}>
      <ul>
        {view.items.map((c) => {
          const busy = view.busyId === c.id;
          const broken = canReconnect(c);
          return (
            <li key={c.id} className="border-t border-border-default first:border-t-0">
              <SettingsRow
                title={c.client_name}
                description={connectionLine(c, date)}
                className="border-t-0"
                leading={
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)] border border-border-default bg-card">
                    <ClientLogo client={c.kind === 'token' ? 'other' : clientFor(c.client_name)} />
                  </span>
                }
              >
                {broken && <SettingsPill tone="bad">Not working</SettingsPill>}
                {broken && onReconnect && (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Reconnect ${c.client_name}`}
                    aria-expanded={reconnectingId === c.id}
                    onClick={() => onReconnect(c)}
                  >
                    Reconnect
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={view.busyId !== null}
                  aria-label={`Disconnect ${c.client_name}`}
                  onClick={() => onDisconnect(c)}
                >
                  {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {busy ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </SettingsRow>
              {broken && reconnectingId === c.id && panel?.(c)}
            </li>
          );
        })}
      </ul>
    </SettingsBox>
  );
}

/** The AI apps you have connected, each with its state, a Reconnect where one is needed, and a way to cut it off. Mounted on Connect your AI. */
export function AiConnectionsSection({ ws, panel }: { ws: string; panel?: (c: AiConnection, close: () => void, recheck: () => Promise<boolean>) => ReactNode }) {
  const list = useAiConnections(ws);
  const disconnect = useDisconnectAiConnection(ws);
  const confirm = useConfirm();
  const fmt = useDateFormat();
  const [open, setOpen] = useState<string | null>(null);

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
    <section aria-label="AI apps" className="mb-[18px]">
      <AiConnectionsList
        view={view}
        date={fmt.date}
        onDisconnect={(c) => void onDisconnect(c)}
        onReconnect={panel ? (c) => setOpen((o) => (o === c.id ? null : c.id)) : undefined}
        reconnectingId={open}
        panel={panel ? (c) => panel(c, () => setOpen(null), async () => {
            const fresh = await list.refetch();
            const now = fresh.data?.find((x) => x.id === c.id);
            return now ? canReconnect(now) : false;
          }) : undefined}
      />
    </section>
  );
}
