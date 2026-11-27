import type { LinearFetcher } from '../../src/integrations/linear.service';

interface FakeTeam {
  id: string;
  key: string;
  name: string;
  /** Ticket #1367 — `Team.private`. */
  private?: boolean;
  data: {
    /** Ticket #1367 — the team's members (`Team.members`), served for a private team's grants. */
    members?: Array<{ id: string; name: string; email?: string | null; active?: boolean }>;
    /** Ticket #1367 — issue history by Linear issue id, newest or oldest first as the test likes; the fake pages it like Linear (first page 50, then 100 at a time). */
    history?: Record<string, Array<Record<string, unknown>>>;
    labels: { nodes: unknown[] };
    cycles: { nodes: unknown[] };
    projects: { nodes: unknown[] };
    issues: { nodes: Array<Record<string, unknown>> };
    /** The team's workflow states; derived from the issues' own statuses when a test does not care. */
    states?: Array<{ id: string; name: string; type: string; position: number }>;
    /** Comments across the team's issues (#903); the fake serves them as one paged stream like the real query. */
    comments?: Array<Record<string, unknown>>;
  };
}

/**
 * A Linear GraphQL fake that PAGES like the real API (#902): it reads `first: N` out of the query text, hands back N
 * nodes per call with a `pageInfo` and an opaque cursor, and caps a page at 250 as Linear does. The old fake returned
 * the whole list from any query, so no test could tell a paged read from a one-shot one.
 *
 * `issueCount` is the separate total (`Team.issueCount`); `calls` records every query so a test can see how many
 * pages were read.
 */
export function makeLinearFetcher(teams: FakeTeam[], opts: { issueCount?: (t: FakeTeam) => number | undefined } = {}) {
  const calls: string[] = [];
  const fetcher: LinearFetcher = async (query, variables) => {
    calls.push(String(query.match(/query (\w+)/)?.[1]));
    /** #1027 — an `updatedAt > since` filter, as the incremental queries send. A node with no `updatedAt` always counts as changed. */
    const sinceOnly = <T extends Record<string, unknown>>(all: T[]) => {
      const since = variables['since'];
      if (typeof since !== 'string') return all;
      return all.filter((n) => typeof n['updatedAt'] !== 'string' || n['updatedAt'] > since);
    };
    const page = <T,>(all: T[]) => {
      const first = Math.min(Number(query.match(/first: (\d+)/)?.[1] ?? 50), 250);
      const start = variables['after'] ? Number(variables['after']) : 0;
      const nodes = all.slice(start, start + first);
      const end = start + nodes.length;
      return { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } };
    };
    if (query.includes('query Teams(')) return { teams: page(teams.map(({ id, key, name, private: isPrivate }) => ({ id, key, name, private: isPrivate === true }))) };
    if (query.includes('query TeamComments')) {
      const t = teams.find((x) => x.id === variables['id']);
      if (!t) throw new Error('fake Linear: no such team for comments');
      return { comments: page(sinceOnly(t.data.comments ?? [])) };
    }
    if (query.includes('query IssueHistoryMore')) {
      const all = teams.map((t) => t.data.history?.[variables['id'] as string]).find(Boolean) ?? [];
      const start = Number(variables['after'] ?? 0);
      const nodes = all.slice(start, start + 100);
      return { issue: { history: { nodes, pageInfo: { hasNextPage: start + nodes.length < all.length, endCursor: String(start + nodes.length) } } } };
    }
    const team = teams.find((t) => t.id === variables['id']);
    if (!team) throw new Error(`fake Linear: no team ${String(variables['id'])}`);
    if (query.includes('TeamIssueCount')) {
      if (variables['since'] !== undefined) throw new Error('fake Linear: an incremental read must not ask for the total');
    }
    if (query.includes('TeamMembers')) return { team: { members: page(team.data.members ?? []) } };
    if (query.includes('TeamIssueHistory')) {
      const firstHistory = Number(query.match(/history\(first: (\d+)/)?.[1] ?? 50);
      const withHistory = sinceOnly(team.data.issues.nodes).map((n) => {
        const all = team.data.history?.[n['id'] as string] ?? [];
        const nodes = all.slice(0, firstHistory);
        return { id: n['id'], history: { nodes, pageInfo: { hasNextPage: nodes.length < all.length, endCursor: String(nodes.length) } } };
      });
      return { team: { issues: page(withHistory) } };
    }
    if (query.includes('TeamIssueCount')) return { team: { issueCount: opts.issueCount ? opts.issueCount(team) : team.data.issues.nodes.length } };
    if (query.includes('TeamLabels')) return { team: { labels: page(team.data.labels.nodes) } };
    if (query.includes('TeamCycles')) return { team: { cycles: page(team.data.cycles.nodes) } };
    if (query.includes('TeamProjects')) return { team: { projects: page(team.data.projects.nodes) } };
    if (query.includes('TeamStates')) {
      const derived = [...new Map(team.data.issues.nodes.map((n) => [(n['state'] as { name: string }).name, (n['state'] as { name: string; type: string })])).values()]
        .map((st, i) => ({ id: `st-${i}`, name: st.name, type: st.type, position: i }));
      return { team: { states: page(team.data.states ?? derived) } };
    }
    if (query.includes('TeamIssues')) {
      const withInfo = team.data.issues.nodes.map((n) => ({
        // Linear always reports `number`; a fixture that only wrote an identifier gets the number the identifier carries.
        number: Number(String(n['identifier']).match(/(\d+)$/)?.[1]),
        ...n,
        labels: { ...(n['labels'] as { nodes: unknown[] }), pageInfo: { hasNextPage: false, endCursor: null } },
      }));
      return { team: { issues: page(sinceOnly(withInfo)) } };
    }
    throw new Error(`fake Linear: unrecognised query ${query.slice(0, 40)}`);
  };
  return { fetcher, calls };
}

/** n synthetic issues, spread over the given project ids (or none). */
export function manyIssues(n: number, projectIds: Array<string | null> = [null]): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `iss-${i}`, identifier: `BIG-${i + 1}`, title: `Issue ${i + 1}`, description: null,
    url: `https://linear.app/acme/issue/BIG-${i + 1}`, estimate: null, priority: 0,
    state: { type: 'unstarted', name: 'Todo' }, labels: { nodes: [] }, assignee: null, parent: null, cycle: null,
    project: projectIds[i % projectIds.length] ? { id: projectIds[i % projectIds.length] } : null,
  }));
}
