import type { LinearFetcher } from '../../src/integrations/linear.service';
import { serveLinearExtras } from './linear-attachments-fake';

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
    /** Ticket #1364 — project milestones; each names its owning project by `projectId`. Absent = the team has none. */
    milestones?: Array<{ id: string; projectId: string; name: string; description?: string | null; targetDate?: string | null; sortOrder?: number }>;
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
/**
 * Ticket #1365 — a relation edge in the shape of Linear's documented `IssueRelation` (`type` blocks / duplicate / related /
 * similar; `issue` is the source, `relatedIssue` the target). HAND-WRITTEN from the published schema, NOT recorded from a
 * live Linear: the fake derives each issue's `relations` (edges where it is `issue`) and `inverseRelations` (where it is
 * `relatedIssue`) from this one list, as Linear does.
 */
export interface FakeRelationEdge { id: string; type: string; issue: { id: string }; relatedIssue: { id: string } }

export interface FakeLinearOptions {
  issueCount?: (t: FakeTeam) => number | undefined;
  relationEdges?: FakeRelationEdge[];
  /** Team keys of issues that are in NO fake team (an issue of a team the key does not import). */
  foreignIssueTeams?: Record<string, string>;
  /** Issue ids whose nested relation lists claim another page (`hasNextPage`), to prove an incomplete list fails the read. */
  relationsIncomplete?: Set<string>;
  /** Issue ids the relations stream leaves out (the relation read disagreeing with the issue read). */
  relationsOmit?: Set<string>;
  /** Ticket #1393 — override the answer to a FILTERED `issueCount` (the scope's own total), to prove a count mismatch is refused. */
  scopedIssueCount?: (t: FakeTeam, filter: Record<string, unknown>) => number;
}

type FilterJson = Record<string, unknown>;
const cmp = (value: unknown, c: Record<string, unknown>): boolean => {
  if (typeof value !== 'string') return false; // a null / absent date matches no date comparison, as in Linear
  if (c['gte'] !== undefined) return value >= String(c['gte']);
  if (c['gt'] !== undefined) return value > String(c['gt']);
  throw new Error(`fake Linear: unsupported date comparator ${JSON.stringify(c)}`);
};
/**
 * Ticket #1393 — a small interpreter for the `IssueFilter` shapes the importer sends (`or`, `and`, `state.type` in/nin, `completedAt` /
 * `canceledAt` / `updatedAt` gte/gt, `id.in`, `team.id.eq`). An unknown key THROWS: a filter this fake cannot read must never be
 * silently treated as "match everything", because then a test of the scope would pass whatever the importer sent.
 */
export function matchesIssueFilter(node: Record<string, unknown>, filter: FilterJson, ownerTeamId?: string): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const v = value as Record<string, unknown>;
    switch (key) {
      case 'or': return (value as FilterJson[]).some((f) => matchesIssueFilter(node, f, ownerTeamId));
      case 'and': return (value as FilterJson[]).every((f) => matchesIssueFilter(node, f, ownerTeamId));
      case 'state': {
        const type = (node['state'] as { type: string }).type;
        const t = (v['type'] ?? {}) as { in?: string[]; nin?: string[] };
        return (t.in ? t.in.includes(type) : true) && (t.nin ? !t.nin.includes(type) : true);
      }
      case 'completedAt': case 'canceledAt': return cmp(node[key], v);
      case 'updatedAt': return typeof node['updatedAt'] !== 'string' || cmp(node['updatedAt'], v); // the fake's incremental convention
      case 'id': return (v['in'] as string[]).includes(String(node['id']));
      case 'team': return ownerTeamId === undefined || (v['id'] as { eq: string }).eq === ownerTeamId;
      default: throw new Error(`fake Linear: unsupported issue filter key "${key}"`);
    }
  });
}

export function makeLinearFetcher(teams: FakeTeam[], opts: FakeLinearOptions = {}) {
  const calls: string[] = [];
  /** Ticket #1393 — every request with its variables, so a test can see exactly which ids a stream was asked for. */
  const requests: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const fetcher: LinearFetcher = async (query, variables) => {
    calls.push(String(query.match(/query (\w+)/)?.[1]));
    requests.push({ name: String(query.match(/query (\w+)/)?.[1]), variables });
    const queryName = String(query.match(/query (\w+)/)?.[1]);
    /** Ticket #1393 — the scoped and by-ids reads keep their operation names (so name-based assertions still read the same stream); their VARIABLES tell them apart. */
    /** Ticket #1393 — an `id: { in: $ids }` narrowing, as the by-ids queries send. */
    const idsOnly = <T extends Record<string, unknown>>(all: T[]) => (Array.isArray(variables['ids']) ? all.filter((n) => (variables['ids'] as string[]).includes(String(n['id']))) : all);
    const extras = serveLinearExtras(query, variables, teams as never); // ticket #1366: attachments and documents
    if (extras !== undefined) return extras;
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
    if ((queryName === 'TeamComments' || queryName === 'TeamCommentsSince') && variables['issue'] !== undefined) {
      const issueFilter = variables['issue'] as FilterJson;
      const teamId = (issueFilter['team'] as { id: { eq: string } }).id.eq;
      const t = teams.find((x) => x.id === teamId);
      if (!t) throw new Error('fake Linear: no such team for scoped comments');
      const inScope = new Set(t.data.issues.nodes.filter((n) => matchesIssueFilter(n, issueFilter, t.id)).map((n) => String(n['id'])));
      const mine = (t.data.comments ?? []).filter((c) => inScope.has(String((c['issue'] as { id: string }).id)));
      return { comments: page(sinceOnly(mine)) };
    }
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
    if (query.includes('query ProjectMilestonesPaged')) {
      const all = teams.flatMap((t) => t.data.milestones ?? []).filter((m) => m.projectId === variables['id']);
      return { project: { projectMilestones: page(all.map(({ projectId: _p, ...m }) => m)) } };
    }
    const team = teams.find((t) => t.id === variables['id']);
    if (!team) throw new Error(`fake Linear: no team ${String(variables['id'])}`);
    if (query.includes('query TeamRelations')) {
      const teamOf = (id: unknown) => teams.find((t) => t.data.issues.nodes.some((n) => n['id'] === id))?.key ?? opts.foreignIssueTeams?.[String(id)] ?? null;
      const edges = opts.relationEdges ?? [];
      const nodes = idsOnly(team.data.issues.nodes).filter((n) => !opts.relationsOmit?.has(String(n['id']))).map((n) => {
        // `i2` makes both lists claim another page; `in:i2` only the incoming one.
        const done = { hasNextPage: opts.relationsIncomplete?.has(String(n['id'])) ?? false, endCursor: null };
        const doneIn = { hasNextPage: done.hasNextPage || (opts.relationsIncomplete?.has(`in:${String(n['id'])}`) ?? false), endCursor: null };
        return {
          id: n['id'], updatedAt: n['updatedAt'],
          relations: { nodes: edges.filter((e) => e.issue.id === n['id']).map((e) => ({ id: e.id, type: e.type, relatedIssue: { id: e.relatedIssue.id, team: { key: teamOf(e.relatedIssue.id) } } })), pageInfo: done },
          inverseRelations: { nodes: edges.filter((e) => e.relatedIssue.id === n['id']).map((e) => ({ id: e.id, type: e.type, issue: { id: e.issue.id, team: { key: teamOf(e.issue.id) } } })), pageInfo: doneIn },
        };
      });
      return { team: { issues: page(sinceOnly(nodes)) } };
    }
    if (queryName === 'TeamIssueCount' && variables['filter'] !== undefined) {
      return { team: { issueCount: opts.scopedIssueCount ? opts.scopedIssueCount(team, variables['filter'] as FilterJson) : team.data.issues.nodes.filter((n) => matchesIssueFilter(n, variables['filter'] as FilterJson)).length } };
    }
    if (queryName === 'TeamScopeCounts') {
      const countOf = (f: FilterJson) => team.data.issues.nodes.filter((n) => matchesIssueFilter(n, f)).length;
      return { team: { open: countOf(variables['open'] as FilterJson), closedRecent: countOf(variables['closedRecent'] as FilterJson) } };
    }
    if ((queryName === 'TeamIssues' || queryName === 'TeamIssuesSince') && variables['filter'] !== undefined) {
      const filter = variables['filter'] as FilterJson;
      const withInfo = team.data.issues.nodes.filter((n) => matchesIssueFilter(n, filter)).map((n) => ({
        number: Number(String(n['identifier']).match(/(\d+)$/)?.[1]),
        ...n,
        labels: { ...(n['labels'] as { nodes: unknown[] }), pageInfo: { hasNextPage: false, endCursor: null } },
      }));
      return { team: { issues: page(withInfo) } };
    }
    if (query.includes('TeamIssueCount')) {
      if (variables['since'] !== undefined) throw new Error('fake Linear: an incremental read must not ask for the total');
    }
    if (query.includes('TeamMembers')) return { team: { members: page(team.data.members ?? []) } };
    if (query.includes('TeamIssueHistory')) {
      const firstHistory = Number(query.match(/history\(first: (\d+)/)?.[1] ?? 50);
      const withHistory = idsOnly(sinceOnly(team.data.issues.nodes)).map((n) => {
        const all = team.data.history?.[n['id'] as string] ?? [];
        const nodes = all.slice(0, firstHistory);
        return { id: n['id'], history: { nodes, pageInfo: { hasNextPage: nodes.length < all.length, endCursor: String(nodes.length) } } };
      });
      return { team: { issues: page(withHistory) } };
    }
    if (query.includes('TeamIssueCount')) return { team: { issueCount: opts.issueCount ? opts.issueCount(team) : team.data.issues.nodes.length } };
    if (query.includes('query TeamProjectMilestones')) {
      // projects(first: N) pages; each project's milestones are the NESTED first page, with its own pageInfo — as Linear does it.
      const nested = Number(query.match(/projectMilestones\(first: (\d+)/)?.[1] ?? 50);
      const projects = (team.data.projects.nodes as Array<{ id: string }>).map((p) => {
        const mine = (team.data.milestones ?? []).filter((m) => m.projectId === p.id).map(({ projectId: _p, ...m }) => m);
        return { id: p.id, projectMilestones: { nodes: mine.slice(0, nested), pageInfo: { hasNextPage: mine.length > nested, endCursor: mine.length > nested ? String(nested) : null } } };
      });
      return { team: { projects: page(projects) } };
    }
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
  return { fetcher, calls, requests };
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
