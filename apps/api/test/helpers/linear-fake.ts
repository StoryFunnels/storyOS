import type { LinearFetcher } from '../../src/integrations/linear.service';

interface FakeTeam {
  id: string;
  key: string;
  name: string;
  data: {
    labels: { nodes: unknown[] };
    cycles: { nodes: unknown[] };
    projects: { nodes: unknown[] };
    issues: { nodes: Array<Record<string, unknown>> };
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
    const page = <T,>(all: T[]) => {
      const first = Math.min(Number(query.match(/first: (\d+)/)?.[1] ?? 50), 250);
      const start = variables['after'] ? Number(variables['after']) : 0;
      const nodes = all.slice(start, start + first);
      const end = start + nodes.length;
      return { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } };
    };
    if (query.includes('query Teams(')) return { teams: page(teams.map(({ id, key, name }) => ({ id, key, name }))) };
    const team = teams.find((t) => t.id === variables['id']);
    if (!team) throw new Error(`fake Linear: no team ${String(variables['id'])}`);
    if (query.includes('TeamIssueCount')) return { team: { issueCount: opts.issueCount ? opts.issueCount(team) : team.data.issues.nodes.length } };
    if (query.includes('TeamLabels')) return { team: { labels: page(team.data.labels.nodes) } };
    if (query.includes('TeamCycles')) return { team: { cycles: page(team.data.cycles.nodes) } };
    if (query.includes('TeamProjects')) return { team: { projects: page(team.data.projects.nodes) } };
    if (query.includes('TeamIssues')) {
      const withInfo = team.data.issues.nodes.map((n) => ({
        ...n,
        labels: { ...(n['labels'] as { nodes: unknown[] }), pageInfo: { hasNextPage: false, endCursor: null } },
      }));
      return { team: { issues: page(withInfo) } };
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
