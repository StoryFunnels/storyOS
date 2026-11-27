/**
 * Ticket #1388 (the web half of #1377) — a Slack channel subscribed to a space or a database, as the settings screen reads and writes it.
 *
 * The API decides everything that matters (admin-only, uniqueness, which targets are refused, whether a restricted target needs
 * `acknowledge_restricted`); this module only words what the API sends and checks what is cheap to check before the round trip.
 * It never invents a figure: counts are the API's, and a failure is shown as the API's own text, never branched on.
 */
export type SlackEvent = 'created' | 'status_changed' | 'commented';

export const SLACK_EVENTS: ReadonlyArray<{ value: SlackEvent; label: string }> = [
  { value: 'created', label: 'Record created' },
  { value: 'status_changed', label: 'Status changed' },
  { value: 'commented', label: 'Comment added' },
];

export type SlackNeedsAttention = 'creator_left' | 'creator_not_admin';

export interface SlackSubscriptionDto {
  id: string;
  channel: string | null;
  events: SlackEvent[];
  created_by: string;
  created_by_name?: string | null;
  needs_attention: SlackNeedsAttention | null;
  sent_count: number;
  failed_count: number;
  last_error: string | null;
  last_error_at: string | null;
  last_sent_at: string | null;
  created_at: string;
  scope: { kind: 'space' | 'database'; id: string; name: string; space_id?: string };
  /** The target is closed to some members: its record titles go to a channel whose membership StoryOS does not control. */
  closed: boolean;
}

/** The subscriptions of ONE space or database, out of the workspace list. A space's own rows never include its databases' (they have their own screens). */
export function forTarget(list: readonly SlackSubscriptionDto[], kind: 'space' | 'database', id: string): SlackSubscriptionDto[] {
  return list.filter((s) => s.scope.kind === kind && s.scope.id === id);
}

export function eventsLine(events: readonly SlackEvent[]): string {
  const words = SLACK_EVENTS.filter((e) => events.includes(e.value)).map((e) => e.label.toLowerCase());
  if (words.length === 0) return 'No events';
  const [first, ...rest] = words;
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(', ');
}

/** "#general" for a name, the id as typed for a channel id, and the connection's own channel when none is stored. */
export function channelLabel(channel: string | null): string {
  if (!channel || channel.trim() === '') return 'The connection’s channel';
  const c = channel.trim().replace(/^#/, '');
  return /^[CGD][A-Z0-9]{6,}$/.test(c) ? c : `#${c}`;
}

/** The same channel inside a sentence ("Stopped posting to #general", "…to the connection’s channel"): no capital mid-sentence. */
export function channelInSentence(channel: string | null): string {
  return !channel || channel.trim() === '' ? 'the connection’s channel' : channelLabel(channel);
}

/** Why a subscription is not posting, as a sentence, or null when it is. Sent as a code by the API; the words are ours. */
export function attentionLine(code: SlackNeedsAttention | null, creatorName: string | null | undefined): string | null {
  if (code === 'creator_left') return `Not posting: ${creatorName ?? 'the admin who added it'} is no longer in this workspace. Remove it, then add the channel again as yourself.`;
  if (code === 'creator_not_admin') return `Not posting: ${creatorName ?? 'the admin who added it'} is no longer an admin. Remove it, then add the channel again as yourself.`;
  return null;
}

/** The API's refusal for a closed target that was not acknowledged starts with this (it has no code today). A drift test reads the API source. */
export const RESTRICTED_REFUSAL_PREFIX = 'This space or database is restricted';

export function isRestrictedRefusal(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(RESTRICTED_REFUSAL_PREFIX);
}

/**
 * `inherited` is a database that is not itself restricted but sits in a restricted space (the API asked for the confirmation, the
 * database's own flag did not): saying "{name} is a restricted database" would be false there.
 */
export function restrictedNotice(kind: 'space' | 'database', name: string, inherited = false): string {
  const who = inherited ? `${name} sits in a restricted space, so only some members can open it.` : `${name} is a restricted ${kind}: only some members can open it.`;
  return `${who} Its record titles will be posted to this Slack channel, and StoryOS cannot control who is in the channel.`;
}

/** The API's error code (`error.code`, derived from the HTTP status) on a refusal as the web client receives it, or null. */
export function errorCode(error: unknown): string | null {
  const code = (error as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * A 409 on add means that channel already has a subscription here. The API's sentence tells the person to "change the existing one",
 * and this screen has no edit: remove it and add it again is what they can do, so the screen says that instead.
 */
export const DUPLICATE_CHANNEL_LINE = 'That channel already has a subscription here. Remove it first if you want different events.';

/** "Connect Slack first…" (no bot token or webhook saved): the screen adds a link to where that is done. A drift test reads the API source. */
export const CONNECT_SLACK_PREFIX = 'Connect Slack first';
export function isConnectSlackRefusal(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(CONNECT_SLACK_PREFIX);
}

export const CHANNEL_MAX = 100;

export interface SlackDraft {
  /** What to send, or null while the form is not valid. */
  body: { events: SlackEvent[]; channel?: string; acknowledge_restricted?: true } | null;
  error: string | null;
}

export function addDraft(input: { events: readonly SlackEvent[]; channel: string; needsAcknowledge: boolean; acknowledged: boolean }): SlackDraft {
  if (input.events.length === 0) return { body: null, error: 'Pick at least one event.' };
  const channel = input.channel.trim();
  if (channel.length > CHANNEL_MAX) return { body: null, error: `A channel name or ID is at most ${CHANNEL_MAX} characters.` };
  if (input.needsAcknowledge && !input.acknowledged) return { body: null, error: null };
  return {
    body: {
      events: SLACK_EVENTS.map((e) => e.value).filter((v) => input.events.includes(v)),
      ...(channel === '' ? {} : { channel }),
      ...(input.needsAcknowledge ? { acknowledge_restricted: true as const } : {}),
    },
    error: null,
  };
}
