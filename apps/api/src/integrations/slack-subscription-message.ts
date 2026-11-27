import { escapeSlackText } from './slack.service';

/**
 * Ticket #1377 - what a Slack channel subscription says. ONE place, so the three events cannot drift apart, and so the rule "a message
 * carries the record title, identifier, state, who did it and a link, and NOTHING ELSE" is a function a test can read, not a habit.
 *
 * No description, no field value, no comment text: the channel's readers are not StoryOS members, so the only things that may leave
 * are the ones the admin who made the subscription was told about (see the `acknowledge_restricted` rule in the service).
 *
 * Every string that came from a person (title, state label, a name) goes through `escapeSlackText`, so `<!channel>`, `<@U123>` or
 * `<https://evil|Click>` in a title arrives as literal text and pings nobody. What StoryOS writes itself, its own `<url|label>`, stays raw.
 */
export type SubscriptionEventKind = 'created' | 'status_changed' | 'commented';

/** What made the change, as the message says it. `null` is a person typing. Never an AI's name: the actor is always the member. */
export type ViaKind = 'agent' | 'automation' | 'mcp' | 'sync' | null;

export interface SubscriptionMessageInput {
  kind: SubscriptionEventKind;
  /** The record's title as a NARROWED reader sees it (`title_local ?? title`): derived values from a closed database never leave. */
  title: string;
  /** `PREFIX-123` when the database has identifiers, else null. */
  identifier: string | null;
  state: string | null;
  /** The state before, for `status_changed` only. */
  previousState?: string | null;
  /** The member's name; null for an anonymous write (a public form). */
  actorName: string | null;
  via: ViaKind;
  url: string;
}

const LABEL_MAX = 150;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const VIA_TEXT: Record<Exclude<ViaKind, null>, string> = {
  agent: 'via agent',
  automation: 'via automation',
  mcp: 'via MCP',
  sync: 'via sync',
};

export function renderSubscriptionMessage(i: SubscriptionMessageInput): string {
  const label = oneLine([i.identifier, i.title.trim() || 'Untitled'].filter(Boolean).join(' '), LABEL_MAX);
  const who = i.actorName ? escapeSlackText(oneLine(i.actorName, 80)) : 'Someone';
  const by = `*${who}*${i.via ? ` _${VIA_TEXT[i.via]}_` : ''}`;
  const link = `<${i.url}|${escapeSlackText(label)}>`;
  const state = i.state ? `*${escapeSlackText(oneLine(i.state, 80))}*` : null;
  switch (i.kind) {
    case 'created':
      return `🆕 ${by} created ${link}${state ? `\nState: ${state}` : ''}`;
    case 'status_changed': {
      const from = i.previousState ? `*${escapeSlackText(oneLine(i.previousState, 80))}*` : '_none_';
      return `🔁 ${by} changed the status of ${link}\n${from} → ${state ?? '_none_'}`;
    }
    case 'commented':
      return `💬 ${by} commented on ${link}${state ? `\nState: ${state}` : ''}`;
  }
}

/** One line standing in for a burst: a count and nothing about what changed (never a title). */
export function renderCoalescedMessage(count: number): string {
  return `🔔 ${count} more updates from StoryOS were held back to stay within Slack's rate limit. Open StoryOS to see them.`;
}
