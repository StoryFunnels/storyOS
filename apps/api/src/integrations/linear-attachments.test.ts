import { describe, expect, it } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  MAX_DOCUMENT_BODY_BYTES,
  MAX_URL_LENGTH,
  MAX_WARNINGS_PER_KIND,
  DocumentRun,
  TEAM_ATTACHMENTS_QUERY,
  TEAM_ATTACHMENTS_SINCE_QUERY,
  attachmentName,
  attachmentTallyGap,
  bodyIsOversize,
  classifyAttachmentUrl,
  contentHash,
  documentSummaryGap,
  documentsForTeam,
  emptyAttachmentTally,
  fetchTeamAttachments,
  pullStateLabel,
  teamIsRestricted,
} from './linear-attachments';
import type { LinearDocument } from './linear-attachments';
import type { LinearFetcher } from './linear.service';

/**
 * Ticket #1366. The rules that decide what an attachment IS. Every fixture URL is a made-up one; the Linear response shapes in the fetch tests are
 * HAND-WRITTEN from Linear's documented schema, not recorded from a live Linear.
 */
describe('classifyAttachmentUrl: a pull request is an https github.com /owner/repo/pull/N URL and nothing else', () => {
  it('reads (repo, number) and drops everything after the number', () => {
    expect(classifyAttachmentUrl('https://github.com/acme/api/pull/42')).toEqual({ kind: 'pull_request', repo: 'acme/api', number: 42, url: 'https://github.com/acme/api/pull/42' });
    expect(classifyAttachmentUrl('https://github.com/acme/api/pull/42/files?w=1#diff')).toMatchObject({ kind: 'pull_request', repo: 'acme/api', number: 42, url: 'https://github.com/acme/api/pull/42' });
    expect(classifyAttachmentUrl('  https://www.github.com/Acme/Web.App/pull/7  ')).toMatchObject({ kind: 'pull_request', repo: 'Acme/Web.App', number: 7 });
  });

  it('keeps the same number in two repositories as two different pull requests', () => {
    const a = classifyAttachmentUrl('https://github.com/acme/api/pull/7');
    const b = classifyAttachmentUrl('https://github.com/acme/web/pull/7');
    expect(a).toMatchObject({ repo: 'acme/api', number: 7 });
    expect(b).toMatchObject({ repo: 'acme/web', number: 7 });
  });

  it.each([
    ['a merge commit', 'https://github.com/acme/api/commit/0123456789abcdef'],
    ['a plain issue', 'https://github.com/acme/api/issues/42'],
    ['the pulls list', 'https://github.com/acme/api/pulls'],
    ['a pull number that is not a number', 'https://github.com/acme/api/pull/abc'],
    ['pull number zero', 'https://github.com/acme/api/pull/0'],
    ['http, not https', 'http://github.com/acme/api/pull/42'],
    ['a GitHub Enterprise host', 'https://github.acme.io/acme/api/pull/42'],
    ['a look-alike host', 'https://github.com.evil.example/acme/api/pull/42'],
    ['github.com only in the path', 'https://evil.example/github.com/acme/api/pull/42'],
    ['credentials that make the host something else', 'https://github.com@evil.example/acme/api/pull/42'],
    ['credentials on github.com itself', 'https://user:pw@github.com/acme/api/pull/42'],
    ['a port', 'https://github.com:8443/acme/api/pull/42'],
    ['a suffix look-alike host (notgithub.com)', 'https://notgithub.com/o/r/pull/1'],
    ['a suffix look-alike host (evil-github.com)', 'https://evil-github.com/o/r/pull/1'],
    ['a subdomain of github.com', 'https://gist.github.com/o/r/pull/1'],
    ['a dot-dot owner', 'https://github.com/../api/pull/42'],
  ])('%s is a plain LINK, never a PR record', (_name, url) => {
    expect(classifyAttachmentUrl(url).kind).toBe('link');
  });
});

describe('classifyAttachmentUrl: what is never stored', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['ftp:', 'ftp://example.com/x'],
    ['not a URL', 'just some text'],
    ['empty', '   '],
    ['too long', `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`],
  ])('%s is UNUSABLE', (_name, url) => {
    expect(classifyAttachmentUrl(url).kind).toBe('unusable');
  });

  it('keeps an ordinary http(s) link exactly as given, and normalises one with a space so the url field accepts it', () => {
    expect(classifyAttachmentUrl('https://www.figma.com/file/abc')).toEqual({ kind: 'link', url: 'https://www.figma.com/file/abc' });
    expect(classifyAttachmentUrl('http://intranet.example/a')).toEqual({ kind: 'link', url: 'http://intranet.example/a' });
    const spaced = classifyAttachmentUrl('https://example.com/a b');
    expect(spaced).toEqual({ kind: 'link', url: 'https://example.com/a%20b' });
  });
});

describe('pullStateLabel: an unknown state stays empty, it is never guessed', () => {
  it('reads a known status or state string', () => {
    expect(pullStateLabel({ status: 'merged' })).toBe('Merged');
    expect(pullStateLabel({ state: 'OPEN' })).toBe('Open');
    expect(pullStateLabel({ status: 'closed' })).toBe('Closed');
  });
  it.each([[null], [undefined], ['merged'], [{}], [{ status: 7 }], [{ status: 'draft' }], [{ status: 'in review' }]])('gives null for %j', (m) => {
    expect(pullStateLabel(m)).toBeNull();
  });
});

describe('attachmentName', () => {
  it('uses the title, collapsed, else the fallback, and is capped', () => {
    expect(attachmentName({ title: '  Fix   the\nthing ', url: 'u' }, 'fb')).toBe('Fix the thing');
    expect(attachmentName({ title: null, url: 'u' }, 'acme/api#4')).toBe('acme/api#4');
    expect(attachmentName({ title: '   ', url: 'u' }, 'fb')).toBe('fb');
    expect(attachmentName({ title: 'x'.repeat(1000), url: 'u' }, 'fb')).toHaveLength(300);
  });
});

describe('documents', () => {
  const doc = (id: string, project: string | null, over: Partial<LinearDocument> = {}): LinearDocument => ({
    id, title: `Doc ${id}`, url: null, content: '# Hi', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', creator: null, project: project ? { id: project } : null, ...over,
  });

  it('documentsForTeam keeps only the documents of the team\'s own projects (and none without a project)', () => {
    const docs = [doc('a', 'p1'), doc('b', 'p2'), doc('c', null), doc('d', 'p1')];
    expect(documentsForTeam(docs, new Set(['p1'])).map((d) => d.id)).toEqual(['a', 'd']);
    expect(documentsForTeam(docs, new Set())).toEqual([]);
  });

  it('the body limit is on BYTES, exactly 2 MB is allowed, one more is oversize, and multibyte text counts as bytes', () => {
    expect(bodyIsOversize('a'.repeat(MAX_DOCUMENT_BODY_BYTES))).toBe(false);
    expect(bodyIsOversize('a'.repeat(MAX_DOCUMENT_BODY_BYTES + 1))).toBe(true);
    expect(bodyIsOversize('é'.repeat(MAX_DOCUMENT_BODY_BYTES / 2 + 1))).toBe(true);
    expect(bodyIsOversize(null)).toBe(false);
  });

  it('contentHash is stable and tells different text apart', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
    expect(contentHash(null)).toBe(contentHash(''));
  });

  it('DocumentRun puts every document in exactly one bucket', () => {
    const run = new DocumentRun([doc('placed', 'p1'), doc('nopj', null), doc('outside', 'pX'), doc('failed', 'p1'), doc('both', 'p1')]);
    for (const id of ['placed', 'failed', 'both']) run.target(id);
    run.succeeded('placed');
    run.succeeded('both');
    run.succeeded('both'); // a project that spans two teams: written once per team database
    const s = run.summary();
    expect(s).toMatchObject({ fetched: 5, placed: 2, copies: 3, no_project: 1, project_not_imported: 1, failed: 1 });
    expect(documentSummaryGap(s)).toBe(0);
  });

  it('a lost document shows up as a gap, so the sync can refuse', () => {
    const s = new DocumentRun([doc('a', 'p1')]).summary();
    expect(documentSummaryGap({ ...s, fetched: s.fetched + 1 })).toBe(1);
  });

  it('warnings are capped per kind and the cut-off says how many there were', () => {
    const run = new DocumentRun([]);
    for (let i = 0; i < MAX_WARNINGS_PER_KIND + 5; i++) run.warn('failed documents', `w${i}`);
    run.warn('other', 'one');
    const out = run.finish();
    expect(out.filter((w) => w.startsWith('w'))).toHaveLength(MAX_WARNINGS_PER_KIND);
    expect(out).toContain(`failed documents: 5 more not listed (${MAX_WARNINGS_PER_KIND + 5} in all)`);
    expect(out).toContain('one');
  });

  it('attachmentTallyGap: fetched must equal what became something, was refused, or failed', () => {
    const t = { ...emptyAttachmentTally(), fetched: 10, pull_requests: 3, links: 4, unusable: 1, unplaced: 1, failed: 1 };
    expect(attachmentTallyGap(t)).toBe(0);
    expect(attachmentTallyGap({ ...t, fetched: 11 })).toBe(1);
    // kept_in_team_space is INCLUDED in links, so it must not be counted twice
    expect(attachmentTallyGap({ ...t, kept_in_team_space: 2 })).toBe(0);
  });
});

describe('the attachment reads', () => {
  const team = { id: 't1', key: 'AT', name: 'Attach' };
  const att = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, subtitle: null, url: `https://example.com/${id}`, sourceType: 'url', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...extra });
  const list = (nodes: unknown[], more = false) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: more ? 'c1' : null } });

  it('the incremental query derives from the full one (it cannot silently read everything)', () => {
    expect(TEAM_ATTACHMENTS_SINCE_QUERY).toContain('filter: { updatedAt: { gt: $since } }');
    expect(TEAM_ATTACHMENTS_SINCE_QUERY).toContain('query TeamAttachmentsSince');
    expect(TEAM_ATTACHMENTS_QUERY).not.toContain('$since');
  });

  it('stamps each attachment with the issue it hangs on', async () => {
    const fetcher: LinearFetcher = async () => ({ team: { issues: { nodes: [{ id: 'i1', attachments: list([att('a1'), att('a2')]) }, { id: 'i2', attachments: list([att('a3')]) }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    const out = await fetchTeamAttachments(fetcher, 'k', team);
    expect(out.map((a) => [a.id, a.issueId])).toEqual([['a1', 'i1'], ['a2', 'i1'], ['a3', 'i2']]);
  });

  it('finishes an issue whose attachments run past the nested page, from the cursor Linear gave', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetcher: LinearFetcher = async (query, variables) => {
      seen.push({ query: query.match(/query (\w+)/)![1], ...variables });
      if (query.includes('query IssueAttachments')) return { issue: { attachments: list([att('a3'), att('a4')]) } };
      return { team: { issues: { nodes: [{ id: 'i1', attachments: list([att('a1'), att('a2')], true) }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    };
    const out = await fetchTeamAttachments(fetcher, 'k', team);
    expect(out.map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(seen[1]).toMatchObject({ query: 'IssueAttachments', id: 'i1', after: 'c1' });
  });

  it('REFUSES an issue whose attachment list says nothing about completeness, and one that says "more" with no cursor', async () => {
    const noInfo: LinearFetcher = async () => ({ team: { issues: { nodes: [{ id: 'i1', attachments: { nodes: [att('a1')] } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    await expect(fetchTeamAttachments(noInfo, 'k', team)).rejects.toBeInstanceOf(UnprocessableEntityException);
    const noCursor: LinearFetcher = async () => ({ team: { issues: { nodes: [{ id: 'i1', attachments: { nodes: [att('a1')], pageInfo: { hasNextPage: true, endCursor: null } } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    await expect(fetchTeamAttachments(noCursor, 'k', team)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('asks only for issues changed since, on an incremental read', async () => {
    let asked: Record<string, unknown> = {};
    const fetcher: LinearFetcher = async (query, variables) => {
      asked = { query, ...variables };
      return { team: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    };
    await fetchTeamAttachments(fetcher, 'k', team, { since: '2026-02-01T00:00:00.000Z' });
    expect(asked['query']).toBe(TEAM_ATTACHMENTS_SINCE_QUERY);
    expect(asked['since']).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('teamIsRestricted fails closed', () => {
  it('a space that cannot be read is restricted; otherwise either flag restricts', () => {
    expect(teamIsRestricted(undefined, { restricted: false })).toBe(true);
    expect(teamIsRestricted(null, { restricted: false })).toBe(true);
    expect(teamIsRestricted({ restricted: true }, { restricted: false })).toBe(true);
    expect(teamIsRestricted({ restricted: false }, { restricted: true })).toBe(true);
    expect(teamIsRestricted({ restricted: false }, { restricted: false })).toBe(false);
  });
});
