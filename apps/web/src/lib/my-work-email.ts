import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { UserPreferences } from '@/lib/preferences';

/**
 * "Email me my work" (tickets #1252, #1264; API from #1251/#1470, sender field from #1266/#1486). Everything here is pure or a thin
 * query so the rules the page and the Inbox offer share live ONCE, and can be tested without a DOM.
 *
 * The rule under all of it: show a state only when the server told us. A preference group the API does not return, a sender the API
 * does not name, a total that has not loaded: each hides its piece of UI. None of them is read as "off", "no email" or "0".
 */

export type MyWorkEmailPrefs = NonNullable<UserPreferences['myWorkEmail']>;
export type MyWorkFrequency = MyWorkEmailPrefs['frequency'];

/** The stored hint id for the one-time Inbox offer (per person per workspace, server-side: lib/dismissed-hints.ts). Changing it shows the offer again to everyone. */
export const MY_WORK_OFFER_HINT = 'my-work-email-offer';

/** The offer waits for this many open assigned records (ticket #1252). */
export const MY_WORK_OFFER_MIN_OPEN = 5;

/** The example email Dara drew (prototype v65). An external page: it is Dara's rendering, not a route of this app. */
export const MY_WORK_EXAMPLE_URL = 'https://claude.ai/artifact/AQXYGbhnL8om2jTbjnUJTU';

/** Where an admin reads how to set up email on a self-hosted server (apps/docs: self-hosting/configuration). */
export const EMAIL_SETUP_DOCS_URL = 'https://docs.storyos.dev/self-hosting/configuration';

/** The group as the API returned it, or undefined when the server did not return it (an older API): the box then hides. */
export function myWorkEmailOf(prefs: UserPreferences | undefined): MyWorkEmailPrefs | undefined {
  return prefs?.myWorkEmail;
}

/** Weekdays in the order a week reads, with the API's numbering (0 = Sunday). */
export const WEEKDAY_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];

const HALF_HOURS: string[] = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

/**
 * Every half hour, PLUS the saved time when it is not one of them (an agent or the API can store 09:15). Without that the menu
 * would name the first item as the current value, a time the person never chose.
 */
export function timeOptions(saved: string): { value: string; label: string }[] {
  const all = HALF_HOURS.includes(saved) ? HALF_HOURS : [...HALF_HOURS, saved].sort();
  return all.map((t) => ({ value: t, label: t }));
}

/** "Europe/Madrid (UTC+1)". Null in = the stored zone is "none", which the sender reads as UTC. */
export function zoneLabel(zone: string | null, now: Date = new Date()): string {
  if (!zone) return 'UTC';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value;
    const offset = part ? part.replace('GMT', 'UTC').replace('-', '−') : null;
    return `${zone.replace(/_/g, ' ')}${offset && offset !== 'UTC' ? ` (${offset})` : offset ? ' (UTC)' : ''}`;
  } catch {
    return zone;
  }
}

/** The browser's IANA zone, or null when it cannot say (then a save sends no zone and the stored one stays). */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The PATCH body for one change on the box. The browser's zone rides along on every save (ticket #1252: "in the person's zone named
 * from the browser"), so a person who travelled and then edits gets the zone they are in. Names only what changed plus the zone.
 */
export function myWorkEmailPatch(change: Partial<MyWorkEmailPrefs>, zone: string | null): { myWorkEmail: Partial<MyWorkEmailPrefs> } {
  return { myWorkEmail: zone ? { ...change, timezone: zone } : { ...change } };
}

/**
 * Show the one-time Inbox offer? Only when ALL are known and true: the group came back from the API, it is Off, the hint list loaded
 * and does not hold the offer, and the exact open-assigned total loaded and reaches the threshold. An unknown anything is a no.
 * (`dismissed` is undefined while the list loads: a card must not flash open for someone who already answered.)
 */
export function showMyWorkOffer(input: {
  email: MyWorkEmailPrefs | undefined;
  dismissed: string[] | undefined;
  openAssigned: number | undefined;
}): boolean {
  const { email, dismissed, openAssigned } = input;
  if (!email || email.frequency !== 'off') return false;
  if (!dismissed || dismissed.includes(MY_WORK_OFFER_HINT)) return false;
  return typeof openAssigned === 'number' && openAssigned >= MY_WORK_OFFER_MIN_OPEN;
}

/**
 * The notification events that ALSO go out by email today, with where the code does it (read at ticket #1264, main a0e7bb1e):
 *   mentioned      apps/api/src/comments/comments.service.ts (`emailService.send` kind 'mention', skipped when prefs.mentioned === false)
 *   record_changed apps/api/src/records/watcher-email.service.ts (kind 'record-changed', skipped when prefs.record_changed === false)
 * The other three (assigned, commented, state_changed) reach the Inbox only. A switch controls both the Inbox and, for these two, the
 * email. If the API starts emailing another event, add it here and to the row tag at the same time.
 */
export const EMAILED_EVENTS: ReadonlySet<keyof UserPreferences['notifications']> = new Set(['mentioned', 'record_changed']);

/** What GET /api/v1/me carries that this page needs. `mail_sender` is absent on an API older than PR 1486, `null` when none is configured. */
export interface MeMail {
  email?: string;
  mail_sender?: { name?: string | null; address?: string | null } | null;
}

export function useMeMail() {
  return useQuery({
    queryKey: ['me-mail'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/me' as never);
      if (error) throw error;
      return data as unknown as MeMail;
    },
    staleTime: 60_000,
  });
}

export type EmailLine =
  /** Email goes out: say to whom and from where. */
  | { kind: 'sent'; email: string; senderName: string | null; senderAddress: string }
  /** The server says no sender is configured: tell the person, and give the admin the way to fix it. */
  | { kind: 'not_set_up' }
  /** Not known (loading, failed, or an API without the field): print nothing rather than a guess. */
  | { kind: 'unknown' };

/** "Quill from StoryOS" -> "Quill" (the page says "from Quill (address)"); any other sender name is shown as it is. */
export function senderShortName(name: string | null | undefined): string | null {
  const n = name?.trim();
  if (!n) return null;
  const i = n.toLowerCase().indexOf(' from ');
  return i > 0 ? n.slice(0, i) : n;
}

/**
 * The fact the Notifications page states about email (ticket #1264). `mail_sender === null` is the server saying it has no
 * parseable sender (PR 1486 returns null when MAIL_FROM has no address): the self-hosted message. `undefined` is NOT that: an API
 * that does not have the field cannot tell us, so nothing is claimed.
 */
export function emailLine(me: MeMail | undefined): EmailLine {
  if (!me || me.mail_sender === undefined) return { kind: 'unknown' };
  if (me.mail_sender === null) return { kind: 'not_set_up' };
  const address = me.mail_sender.address?.trim();
  const email = me.email?.trim();
  if (!address || !email) return { kind: 'unknown' };
  return { kind: 'sent', email, senderName: senderShortName(me.mail_sender.name), senderAddress: address };
}
