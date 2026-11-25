import { pluralNoun } from '@/lib/records';
import type { ScopeWords } from './catch-up';

/**
 * Ticket #1224 (web half) - the waiting records BY NAME, from `GET .../agents/{agent}/catch-up` (the API half, PR 1451). Pure rules,
 * so each has a test that fails when it is broken; the words are here too, in one place, so the box, the dialog and the Runs rows
 * cannot reword each other.
 *
 * Three facts the copy leans on, all from the API's contract:
 *  - `total` IS the summary's `catch_up` count. "and N more" is built from it, never from counting rows fetched (ticket #404).
 *  - `not_listed` is how many of `total` the viewer may not open (an admin on a colleague's agent). They are said as a number, never
 *    named, and they are NOT part of "and N more": a record you cannot open is not one you could be shown by asking for more.
 *  - there is no `entered_at`. When a record entered its state is not stored reliably, so nothing here claims a time.
 */

export interface WaitingItem {
  id: string;
  title: string | null;
  database_id: string;
  database_name: string;
}

export interface WaitingList {
  total: number;
  listed_total: number;
  not_listed: number;
  items: WaitingItem[];
  limit: number;
  offset: number;
  truncated: boolean;
}

/** How many names the confirm dialog lists (the contract's default page). */
export const DIALOG_NAMES = 5;

/**
 * The list's usable parts, or null when it cannot be trusted. A list that disagrees with the count the page already shows (the
 * summary moved between the two reads) is not used for names: the box then falls back to the count, which is the one source of
 * truth for how many.
 */
export function usableList(list: WaitingList | null | undefined, count: number | null): WaitingList | null {
  if (!list || count === null) return null;
  if (list.total !== count || !Array.isArray(list.items)) return null;
  if (list.items.length === 0 && list.not_listed === 0) return null;
  return list;
}

/** The title through the one fallback every record surface uses. */
export function itemTitle(item: Pick<WaitingItem, 'title'>): string {
  return item.title || 'Untitled';
}

/** The first `n` items, in the API's order (oldest first, the order a click wakes them). */
export function firstItems(list: WaitingList, n: number): WaitingItem[] {
  return list.items.slice(0, n);
}

/** How many records the list has that it did NOT name among `shown`: the nameable remainder. `not_listed` is deliberately excluded. */
export function moreCount(list: Pick<WaitingList, 'total' | 'not_listed'>, shown: number): number {
  return Math.max(0, list.total - list.not_listed - shown);
}

export function andMoreLine(n: number): string | null {
  return n > 0 ? `and ${n} more` : null;
}

export function notListedLine(n: number): string | null {
  return n > 0 ? `${n} you cannot open` : null;
}

/** "Acme" for one waiting record; null for any other count (the box then keeps its count wording). */
export function singleSubject(list: WaitingList | null): string | null {
  if (!list || list.total !== 1 || list.items.length !== 1) return null;
  return itemTitle(list.items[0]!);
}

/**
 * The Not started row's second line. Only when the trigger state is known does it say a state; otherwise it claims nothing about
 * state or time (the API has no entered_at).
 */
export function notStartedSub(words: ScopeWords): string {
  return words.state ? `Entered ${words.state.label} before the Runner was added` : 'Already waiting. Start catch-up to queue it';
}

export const NOT_STARTED_LABEL = 'Not started';

/** The extra Runs rows after the named ones: what the list did not name, and what the viewer cannot open. */
export function notStartedTail(list: WaitingList, shown: number, words: ScopeWords): string[] {
  const out: string[] = [];
  const more = moreCount(list, shown);
  if (more > 0) out.push(`${more} more ${pluralNoun(words.noun, more)} not started`);
  const hidden = notListedLine(list.not_listed);
  if (hidden) out.push(hidden);
  return out;
}
