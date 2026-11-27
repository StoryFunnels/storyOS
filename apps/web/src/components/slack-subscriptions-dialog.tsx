'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import { apiErrorMessage } from '@/lib/api';
import { useSlackSubscriptionMutations, useSlackSubscriptions } from '@/lib/slack-subscriptions-queries';
import {
  SLACK_EVENTS,
  addDraft,
  attentionLine,
  channelInSentence,
  channelLabel,
  errorCode,
  eventsLine,
  forTarget,
  isConnectSlackRefusal,
  isRestrictedRefusal,
  restrictedNotice,
  DUPLICATE_CHANNEL_LINE,
} from '@/lib/slack-subscriptions';
import type { SlackEvent, SlackSubscriptionDto } from '@/lib/slack-subscriptions';
import { cn } from '@/lib/utils';

/**
 * Ticket #1388 — "Slack notifications" for ONE space or database: the channels that get a message when a record is created, changes
 * status or is commented on, and the way to add and remove them. Admin-only (the API refuses everyone else and the menu item is not
 * drawn for them), never offered in a personal space or on a system database.
 *
 * The list is the workspace's (the API returns every subscription), filtered to this target. A row says where it posts, which events,
 * who added it, how delivery is going (counts and the last error as the API sent them) and, loudly, when it is NOT posting because
 * the admin who added it lost their access (`needs_attention`). A restricted target needs a confirmed notice first, because its titles
 * go to a channel StoryOS does not control; the API enforces it, this asks before sending and again if the API asks.
 */
export function SlackSubscriptionsDialogContent({
  ws,
  kind,
  id,
  name,
  restricted,
}: {
  ws: string;
  kind: 'space' | 'database';
  id: string;
  name: string;
  /** The target's own restricted flag; the API's answer can also ask for the notice (a database inside a restricted space). */
  restricted: boolean;
}) {
  const list = useSlackSubscriptions(ws);
  const m = useSlackSubscriptionMutations(ws);
  const [channel, setChannel] = useState('');
  const [events, setEvents] = useState<SlackEvent[]>(SLACK_EVENTS.map((e) => e.value));
  const [acknowledged, setAcknowledged] = useState(false);
  const [serverAsked, setServerAsked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const needsAcknowledge = restricted || serverAsked;
  const draft = addDraft({ events, channel, needsAcknowledge, acknowledged });
  const rows = forTarget(list.data ?? [], kind, id);

  async function add() {
    if (!draft.body || m.create.isPending) return;
    setProblem(null);
    try {
      await m.create.mutateAsync({ ...(kind === 'space' ? { space_id: id } : { database_id: id }), ...draft.body });
      setChannel('');
      setAcknowledged(false);
      toast.success(`Posting to ${channelInSentence(draft.body.channel ?? null)}`);
    } catch (e) {
      const message = apiErrorMessage(e, 'Could not add the channel. Try again.');
      if (isRestrictedRefusal(e)) setServerAsked(true);
      // A 409 is the duplicate-channel refusal; its own sentence points at an edit this screen does not have.
      setProblem(isRestrictedRefusal(e) ? null : errorCode(e) === 'conflict' ? DUPLICATE_CHANNEL_LINE : message);
    }
  }

  async function remove(row: SlackSubscriptionDto) {
    try {
      await m.remove.mutateAsync(row.id);
      toast.success(`Stopped posting to ${channelInSentence(row.channel)}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not remove it. Try again.'));
    }
  }

  return (
    <DialogContent title={`Slack notifications for ${name}`} className="max-w-xl">
      <div className="flex flex-col gap-4" data-testid="slack-subscriptions">
        <p className="m-0 text-body text-muted">
          Post a message to a Slack channel when a record in this {kind} is created, changes status or gets a comment. A message carries the
          record’s title, its status, who did it and a link, and nothing else.
        </p>

        {list.isPending ? (
          <p role="status" className="m-0 text-body text-muted">
            Loading…
          </p>
        ) : list.isError ? (
          <p role="alert" className="m-0 text-body text-error">
            Could not load the Slack channels.{' '}
            <button type="button" className="font-medium text-primary-text underline" onClick={() => void list.refetch()}>
              Try again
            </button>
          </p>
        ) : rows.length === 0 ? (
          <EmptyState variant="list" data-testid="slack-none" className="px-0" title="No channel is subscribed yet." />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="slack-list">
            {rows.map((row) => (
              <SubscriptionRow key={row.id} row={row} removing={m.remove.isPending && m.remove.variables === row.id} onRemove={() => void remove(row)} />
            ))}
          </ul>
        )}

        <form
          className="flex flex-col gap-2.5 border-t border-border-default pt-3"
          data-testid="slack-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <h3 className="m-0 text-body font-semibold text-ink">Add a channel</h3>
          <div className="flex flex-col gap-1">
            <label htmlFor="slack-channel" className="text-label text-muted">
              Channel
            </label>
            <Input
              id="slack-channel"
              aria-describedby="slack-channel-hint"
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value);
                setProblem(null);
              }}
              placeholder="#general or a channel ID"
              spellCheck={false}
              autoComplete="off"
              className="w-full"
              data-testid="slack-channel"
            />
            <span id="slack-channel-hint" className="text-label text-muted">
              Leave empty if your workspace posts through an incoming webhook, or to use the connection’s default channel.
            </span>
          </div>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-0.5 p-0 text-label text-muted">Post when</legend>
            {SLACK_EVENTS.map((e) => (
              <label key={e.value} className="flex items-center gap-2 text-body text-ink">
                <input
                  type="checkbox"
                  checked={events.includes(e.value)}
                  onChange={(ev) => setEvents((cur) => (ev.target.checked ? [...cur, e.value] : cur.filter((v) => v !== e.value)))}
                />
                {e.label}
              </label>
            ))}
          </fieldset>
          {needsAcknowledge && (
            <label className="flex items-start gap-2 rounded-[var(--radius-control)] border border-warning px-2.5 py-2 text-body text-ink" data-testid="slack-restricted">
              <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>
                <b className="font-semibold">Titles will go to that channel.</b> {restrictedNotice(kind, name, serverAsked && !restricted)} I understand.
              </span>
            </label>
          )}
          {(problem ?? draft.error) && (
            <p role="alert" className="m-0 text-label text-error" data-testid="slack-error">
              {problem ?? draft.error}
              {isConnectSlackRefusal(problem) && (
                <>
                  {' '}
                  <OpenSlackSettingsLink ws={ws} />
                </>
              )}
            </p>
          )}
          <SlackDialogFooter canAdd={Boolean(draft.body) && !m.create.isPending} />
        </form>
      </div>
    </DialogContent>
  );
}

/**
 * "Open Slack settings": goes to the page where the connection is made AND closes this dialog. A dialog left open on top of the page it
 * links to covers it, so the click looks like it did nothing (found in review).
 */
export function OpenSlackSettingsLink({ ws }: { ws: string }) {
  return (
    <DialogClose asChild>
      <Link href={`/w/${ws}/settings/integrations/slack`} className="font-medium text-primary-text underline">
        Open Slack settings
      </Link>
    </DialogClose>
  );
}

/** The footer every dialog here has (Description, Access, Identifier prefix): right-aligned, the secondary action first and the primary last. */
export function SlackDialogFooter({ canAdd }: { canAdd: boolean }) {
  return (
    <div className="flex items-center gap-2" data-testid="slack-footer">
      <div className="ml-auto flex gap-2">
        <DialogClose asChild>
          <Button type="button" variant="secondary">
            Close
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!canAdd}>
          Add channel
        </Button>
      </div>
    </div>
  );
}

export function SubscriptionRow({ row, removing, onRemove }: { row: SlackSubscriptionDto; removing: boolean; onRemove: () => void }) {
  const attention = attentionLine(row.needs_attention, row.created_by_name);
  return (
    <li className={cn('flex flex-col gap-1 rounded-[var(--radius-control)] border px-3 py-2', attention ? 'border-warning' : 'border-border-default')} data-testid="slack-row" data-needs-attention={row.needs_attention ?? undefined}>
      <div className="flex items-center gap-2">
        <b className="min-w-0 flex-1 truncate text-body font-semibold text-ink">{channelLabel(row.channel)}</b>
        <Button type="button" size="sm" variant="secondary" disabled={removing} onClick={onRemove} aria-label={`Remove ${channelInSentence(row.channel)}`}>
          Remove
        </Button>
      </div>
      <p className="m-0 text-label text-muted">
        {eventsLine(row.events)}
        {row.created_by_name ? ` · added by ${row.created_by_name}` : ''}
      </p>
      {attention && (
        <p className="m-0 text-label font-medium text-warning-text" data-testid="slack-attention">
          {attention}
        </p>
      )}
      <p className="m-0 text-label text-muted" data-testid="slack-delivery">
        Sent {row.sent_count}
        {' · '}Failed {row.failed_count}
        {/* Nothing counted yet is not "broken": say what it is waiting for, so a delivery that takes seconds does not read as nothing happening. */}
        {row.sent_count === 0 && row.failed_count === 0 && !attention && ' · Waiting for the first record, status change or comment'}
      </p>
      {row.last_error && (
        <p className="m-0 text-label text-error" data-testid="slack-last-error">
          Last error: {row.last_error}
        </p>
      )}
    </li>
  );
}
