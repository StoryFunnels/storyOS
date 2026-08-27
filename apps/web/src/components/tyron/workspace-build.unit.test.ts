import { describe, expect, it } from 'vitest';

/**
 * #363 — the tick-list must show what THIS build made.
 *
 * The rule is small and the failure it prevents is not: a build run against a
 * workspace that already has databases would otherwise claim credit for them,
 * and someone reshaping an existing workspace ("add a budget field") would be
 * shown a list of everything they already had as if Tyron had just made it.
 *
 * Extracted as a pure function because the component around it is a poll, a
 * mutation and a spinner — none of which are the part that could be wrong.
 */
function createdByThisBuild(
  before: Array<{ id: string }>,
  now: Array<{ id: string; name: string; isSystem?: boolean }>,
): string[] {
  const had = new Set(before.map((d) => d.id));
  return now.filter((d) => !d.isSystem && !had.has(d.id)).map((d) => d.name);
}

describe('#363 build tick-list', () => {
  it('lists the databases this build created', () => {
    const before = [{ id: 'sys-1' }];
    const now = [
      { id: 'sys-1', name: 'Members', isSystem: true },
      { id: 'a', name: 'Clients' },
      { id: 'b', name: 'Projects' },
    ];
    expect(createdByThisBuild(before, now)).toEqual(['Clients', 'Projects']);
  });

  it('never claims credit for databases that were already there', () => {
    // Reshaping an existing workspace is a legitimate second use of this.
    const before = [{ id: 'a' }];
    const now = [
      { id: 'a', name: 'Clients' },
      { id: 'b', name: 'Invoices' },
    ];
    expect(createdByThisBuild(before, now)).toEqual(['Invoices']);
  });

  it('excludes SYSTEM databases', () => {
    /*
     * Members, Agents and Runs are provisioned automatically and exist from the
     * workspace's first second. Counting them would make the tick-list open with
     * three things Tyron did not build, and would make the build offer itself
     * never appear — the empty check uses the same rule.
     */
    const now = [
      { id: 'm', name: 'Members', isSystem: true },
      { id: 'r', name: 'Runs', isSystem: true },
      { id: 'x', name: 'Tasks' },
    ];
    expect(createdByThisBuild([], now)).toEqual(['Tasks']);
  });

  it('is empty before anything appears, rather than guessing', () => {
    // The first seconds of a build show the progress line and no ticks. An
    // optimistic placeholder here would be a tool trace by another name.
    expect(createdByThisBuild([{ id: 'sys' }], [{ id: 'sys', name: 'Members', isSystem: true }])).toEqual([]);
  });
});
