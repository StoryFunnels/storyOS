/**
 * Ticket #1366 — the attachment and document half of the Linear fake, kept in its own file so linear-fake.ts takes ONE hook line.
 *
 * THE RESPONSES BELOW ARE HAND-WRITTEN FROM LINEAR'S DOCUMENTED GRAPHQL SCHEMA (Issue.attachments, Attachment, Document). They are NOT
 * recorded from a live Linear: no API key existed when this was written. They prove the importer's behaviour on the documented shape; they
 * do not prove Linear answers with that shape.
 *
 * Teams carry `data.attachments` (each names its `issueId`) and `data.documents`; both default to empty, so every existing test's sync
 * reads zero of them. Paging mirrors the real connections: the nested attachment list ends at 50 and says so in `pageInfo`.
 */
interface FakeTeamLike { id: string; data: { issues: { nodes: Array<Record<string, unknown>> }; attachments?: Array<Record<string, unknown>>; documents?: Array<Record<string, unknown>>; attachmentOnlyIssues?: string[] } }

const NESTED = 50;
const pageOf = <T,>(all: T[], first: number, after: unknown) => {
  const start = typeof after === 'string' ? Number(after) : 0;
  const nodes = all.slice(start, start + first);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } };
};
const firstOf = (query: string) => Number(query.match(/first: (\d+)/)?.[1] ?? 50);
const strip = ({ issueId: _issueId, ...rest }: Record<string, unknown>) => rest;

/** The answer for an attachment or document query, or undefined when the query is not one of those. */
export function serveLinearExtras(query: string, variables: Record<string, unknown>, teams: FakeTeamLike[]): unknown {
  const name = query.match(/query (\w+)/)?.[1];
  const since = typeof variables['since'] === 'string' ? (variables['since'] as string) : undefined;
  const changed = <T extends Record<string, unknown>>(rows: T[]) => (since ? rows.filter((r) => typeof r['updatedAt'] !== 'string' || (r['updatedAt'] as string) > since) : rows);

  if (name === 'TeamAttachments' || name === 'TeamAttachmentsSince') {
    const team = teams.find((t) => t.id === variables['id']);
    if (!team) throw new Error('fake Linear: no such team for attachments');
    const all = team.data.attachments ?? [];
    // `attachmentOnlyIssues`: issues the attachment walk sees but the issue walk did not (created between the two reads).
    const ids = Array.isArray(variables['ids']) ? (variables['ids'] as string[]) : undefined; // ticket #1393: the by-ids query
    const issues = [...changed(team.data.issues.nodes).filter((n) => !ids || ids.includes(String(n['id']))), ...(ids ? [] : (team.data.attachmentOnlyIssues ?? []).map((id) => ({ id })))];
    const page = pageOf(issues, firstOf(query), variables['after']);
    return {
      team: {
        issues: {
          nodes: page.nodes.map((i) => {
            const mine = all.filter((a) => a['issueId'] === i['id']);
            return { id: i['id'], attachments: { nodes: mine.slice(0, NESTED).map(strip), pageInfo: { hasNextPage: mine.length > NESTED, endCursor: mine.length > NESTED ? String(NESTED) : null } } };
          }),
          pageInfo: page.pageInfo,
        },
      },
    };
  }
  if (name === 'IssueAttachments') {
    const mine = teams.flatMap((t) => t.data.attachments ?? []).filter((a) => a['issueId'] === variables['id']);
    return { issue: { attachments: { ...pageOf(mine.map(strip), 100, variables['after']) } } };
  }
  if (name === 'Documents' || name === 'DocumentsSince') {
    const byId = new Map<string, Record<string, unknown>>();
    for (const t of teams) for (const d of t.data.documents ?? []) byId.set(d['id'] as string, d);
    return { documents: pageOf(changed([...byId.values()]), firstOf(query), variables['after']) };
  }
  return undefined;
}
