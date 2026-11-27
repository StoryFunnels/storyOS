import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Ticket #1367 — the pure parts of the Linear importer's dates / history / people handling, kept apart from the service so each
 * rule can be tested without a database: the issue number, the day a timestamp lands on, who a Linear person is in this
 * workspace, and what a state change becomes.
 */

/** A Linear person as the API gives one. `email` is what a member is matched by; it can be absent (a guest, a hidden address). */
export interface LinearPerson {
  id?: string;
  name: string;
  email?: string | null;
}

/** One entry of an issue's history, reduced to what the importer reads (documented `IssueHistory`; only state changes are kept). */
export interface LinearHistoryEntry {
  id: string;
  createdAt: string;
  actor: LinearPerson | null;
  fromState: { name: string } | null;
  toState: { name: string } | null;
}

/**
 * The public number Linear gave an issue (`ISSUE-5201` -> 5201). Linear's own `number` wins; the identifier is the fallback, and it
 * must carry the team's key, so a mismatched pair is refused instead of numbering a record after somebody else's issue.
 */
export function linearIssueNumber(issue: { number?: unknown; identifier: string }, teamKey: string): number {
  const fromIdentifier = (() => {
    const m = /^(.+)-(\d+)$/.exec(issue.identifier);
    return m && m[1]!.toLowerCase() === teamKey.toLowerCase() ? Number(m[2]) : null;
  })();
  const n = typeof issue.number === 'number' && Number.isInteger(issue.number) ? issue.number : fromIdentifier;
  if (n === null || !Number.isInteger(n) || n < 1) {
    throw new UnprocessableEntityException(`Linear issue ${issue.identifier} has no usable number — refusing to number it by guesswork`);
  }
  if (fromIdentifier !== null && fromIdentifier !== n) {
    throw new UnprocessableEntityException(`Linear issue ${issue.identifier} reports number ${n}, which its identifier contradicts — refusing to import it`);
  }
  return n;
}

/** The calendar day (UTC) of a Linear timestamp, or a timeless date as is; null for nothing. */
export function linearDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** A Linear timestamp as a Date, or null when absent or unparseable (a bad value must not stamp "now" over a real date). */
export function linearTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface DirectoryMember {
  id: string;
  email: string;
}

/**
 * Linear people -> workspace members, by email and nothing else. A display name is NOT an identity (two people share one, one person
 * changes it: ADR-0017), so a person Linear gives no email for stays unmatched rather than being guessed at.
 */
export class MemberMatcher {
  private readonly byEmail = new Map<string, string>();
  private readonly seenPeople = new Map<string, { email: string | null; name: string; count: number; matched: boolean }>();

  constructor(directory: DirectoryMember[]) {
    for (const m of directory) if (m.email) this.byEmail.set(m.email.trim().toLowerCase(), m.id);
  }

  /** The member's user id, or null. Does not count anything. */
  find(person: LinearPerson | null | undefined): string | null {
    const email = person?.email?.trim().toLowerCase();
    return email ? (this.byEmail.get(email) ?? null) : null;
  }

  /** Like `find`, and records the person for the run report (one count per issue assigned, or comment written). */
  match(person: LinearPerson | null | undefined): string | null {
    if (!person) return null;
    const id = this.find(person);
    const key = person.email?.trim().toLowerCase() || `name:${person.name.trim().toLowerCase()}`;
    const row = this.seenPeople.get(key) ?? { email: person.email?.trim() || null, name: person.name, count: 0, matched: id !== null };
    row.count++;
    this.seenPeople.set(key, row);
    return id;
  }

  /** What the run report says: how many people were seen, how many matched, and every one that did not (never silently dropped). */
  report(cap = 200): { linear_people: number; matched: number; unmatched_total: number; unmatched: Array<{ email: string | null; name: string; count: number }> } {
    const all = [...this.seenPeople.values()];
    const unmatched = all.filter((p) => !p.matched).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return {
      linear_people: all.length,
      matched: all.length - unmatched.length,
      unmatched_total: unmatched.length,
      unmatched: unmatched.slice(0, cap).map(({ email, name, count }) => ({ email, name, count })),
    };
  }
}

export interface StateHistoryRow {
  at: Date;
  actorUserId: string | null;
  oldValue: string | null;
  newValue: string;
}

/**
 * An issue's state changes as history rows on the State field. Oldest first, at their real times, the person as actor when a member
 * matches. A change into a state this database has no option for is COUNTED, not mapped to a neighbour. Entries that are not state
 * changes (title, priority, assignee edits) are not rows here.
 */
export function stateHistoryRows(
  entries: LinearHistoryEntry[],
  optionByName: Map<string, string>,
  find: (p: LinearPerson | null) => string | null,
): { rows: StateHistoryRow[]; skipped: number } {
  const rows: StateHistoryRow[] = [];
  let skipped = 0;
  const ordered = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const lookup = (name: string) => {
    const key = name.trim().toLowerCase();
    for (const [label, id] of optionByName) if (label.trim().toLowerCase() === key) return id;
    return null;
  };
  for (const e of ordered) {
    if (!e.toState) continue;
    const at = linearTime(e.createdAt);
    const to = lookup(e.toState.name);
    const from = e.fromState ? lookup(e.fromState.name) : null;
    if (!at || !to || (e.fromState && !from)) {
      skipped++;
      continue;
    }
    rows.push({ at, actorUserId: find(e.actor), oldValue: from, newValue: to });
  }
  return { rows, skipped };
}
