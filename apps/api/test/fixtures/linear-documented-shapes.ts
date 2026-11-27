/**
 * DOCUMENTED-SHAPE FIXTURES, NOT LIVE CAPTURES (ticket #1367).
 *
 * No Linear API key existed when the dates / history / members upgrade was built, so nothing in this file was recorded from Linear. Every
 * shape below is hand-written from Linear's published GraphQL schema (Issue.createdAt / updatedAt / startedAt / completedAt / dueDate /
 * number / assignee { email }, IssueHistory { actor, fromState, toState, createdAt }, Team.private, Team.members). They prove the importer
 * handles those shapes; they do NOT prove Linear returns them, with those names, to this key, at that cost. The probe script
 * (scripts/linear-probe.mjs) is what settles that against the real API, and its output replaces these as the evidence.
 *
 * Names, emails and ids are invented. No fixture holds real people or real issues.
 */
export const FIXTURES_ARE_DOCUMENTED_SHAPES_NOT_LIVE_CAPTURES = true;

export const WORKFLOW_STATES = [
  { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'st-prog', name: 'In Progress', type: 'started', position: 2 },
  { id: 'st-done', name: 'Done', type: 'completed', position: 3 },
];

export const person = (name: string, email: string | null) => ({ id: `lin-user-${name.toLowerCase().replace(/\W+/g, '-')}`, name, email });

/** A Linear issue as the documented `issues` node carries it, with real (non-import) dates. */
export function issueShape(team: { key: string }, n: number, over: Record<string, unknown> = {}) {
  return {
    id: `lin-${team.key.toLowerCase()}-${n}`,
    identifier: `${team.key}-${n}`,
    number: n,
    title: `Issue ${n}`,
    description: null,
    url: `https://linear.app/acme/issue/${team.key}-${n}`,
    estimate: null,
    priority: 0,
    createdAt: '2025-03-04T09:00:00.000Z',
    updatedAt: '2025-06-01T12:30:00.000Z',
    startedAt: '2025-03-10T08:00:00.000Z',
    completedAt: null as string | null,
    dueDate: '2025-07-01' as string | null,
    state: { type: 'started', name: 'In Progress' },
    labels: { nodes: [] },
    assignee: null as null | { id?: string; name: string; email?: string | null },
    parent: null,
    cycle: null,
    project: null,
    ...over,
  };
}

/** One documented `IssueHistory` node. A state change has fromState / toState; other kinds of change have neither. */
export function historyShape(id: string, createdAt: string, from: string | null, to: string | null, actor: { id?: string; name: string; email?: string | null } | null) {
  return { id, createdAt, actor, fromState: from ? { name: from } : null, toState: to ? { name: to } : null };
}

export function commentShape(n: number, issueId: string, user: { id?: string; name: string; email?: string | null } | null, over: Record<string, unknown> = {}) {
  return {
    id: `lin-c-${n}`,
    body: `Comment ${n}`,
    createdAt: new Date(Date.UTC(2025, 4, 2, 10, 0, n)).toISOString(),
    url: `https://linear.app/acme/issue/X-1#comment-lin-c-${n}`,
    user,
    botActor: null,
    externalUser: null,
    issue: { id: issueId },
    ...over,
  };
}
