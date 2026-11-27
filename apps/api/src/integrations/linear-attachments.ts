import { UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { pageAll } from './linear-paging';
import type { PageInfo } from './linear-paging';
import type { LinearFetcher, LinearTeam } from './linear.service';

/**
 * Ticket #1366 — what Linear's attachments and documents look like on the way in, and the pure rules for them.
 *
 * THE SHAPES BELOW ARE FROM LINEAR'S PUBLISHED GRAPHQL SCHEMA, NOT FROM A LIVE CALL. No Linear API key was available when this was
 * written. Every field named here (`Issue.attachments`, `Attachment.{title,subtitle,url,sourceType}`, `documents`, `Document.{title,
 * content,project,creator}`) has not yet been run against Linear; the probe that does so is listed in the ticket. A query Linear rejects
 * fails the sync loudly (the fetcher throws), it never produces a quietly empty import.
 *
 * Nothing in this file, or in the service that uses it, ever fetches an attachment's URL: it is DATA that Linear's users typed. The only
 * network traffic is the GraphQL fetcher the sync already has (an attachment URL is never an SSRF target).
 */

/** One Linear attachment, with the issue it hangs on (`issueId` is added by the reader; the nested query does not repeat it). */
export interface LinearAttachment {
  id: string;
  title: string | null;
  subtitle: string | null;
  url: string;
  /** Linear's own label for where it came from (`github`, `githubCommit`, `figma`, `url`, ...). Kept as text; never trusted for what the URL is. */
  sourceType: string | null;
  /** Linear's free-form metadata for the integration that made it (JSONObject). Read for nothing but a PR's state; see `pullStateLabel`. */
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  issueId: string;
}

export interface LinearDocument {
  id: string;
  title: string;
  url: string | null;
  /** Markdown. Null when the document is empty. */
  content: string | null;
  createdAt: string;
  updatedAt: string;
  creator: { name: string } | null;
  /** The project the document hangs off. Null = it hangs off something else (an issue, an initiative) or nothing. */
  project: { id: string } | null;
}

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
/** Deliberately modest, like the issue page: Linear rejects a query whose complexity is too high, and each issue here carries a nested list. NOT measured against the live API. */
export const ATTACHMENT_ISSUE_PAGE_SIZE = 25;
export const ATTACHMENTS_PER_ISSUE_PAGE = 50;
export const DOCUMENT_PAGE_SIZE = 50;
const ATTACHMENT_FIELDS = 'id title subtitle url sourceType metadata createdAt updatedAt';

/**
 * Attachments of every issue of one team, read as their OWN walk (the issue query is untouched, so nothing here multiplies its
 * complexity). The nested list is paged: an issue with more attachments than one page is finished by `ISSUE_ATTACHMENTS_QUERY`.
 */
export const TEAM_ATTACHMENTS_QUERY = `query TeamAttachments($id: String!, $after: String) {
  team(id: $id) {
    issues(first: ${ATTACHMENT_ISSUE_PAGE_SIZE}, after: $after) {
      nodes {
        id
        attachments(first: ${ATTACHMENTS_PER_ISSUE_PAGE}) { nodes { ${ATTACHMENT_FIELDS} } ${PAGE_INFO} }
      }
      ${PAGE_INFO}
    }
  }
}`;
export const TEAM_ATTACHMENTS_SINCE_QUERY = TEAM_ATTACHMENTS_QUERY
  .replace('query TeamAttachments($id: String!, $after: String)', 'query TeamAttachmentsSince($id: String!, $after: String, $since: DateTimeOrDuration!)')
  .replace(`issues(first: ${ATTACHMENT_ISSUE_PAGE_SIZE}, after: $after)`, `issues(first: ${ATTACHMENT_ISSUE_PAGE_SIZE}, after: $after, filter: { updatedAt: { gt: $since } })`);
if (!TEAM_ATTACHMENTS_SINCE_QUERY.includes('TeamAttachmentsSince') || !TEAM_ATTACHMENTS_SINCE_QUERY.includes('updatedAt: { gt: $since }')) {
  // Same guard as TEAM_ISSUES_SINCE_QUERY: the derivation is textual, so a reworded base must fail at load, not read everything silently.
  throw new Error('TEAM_ATTACHMENTS_SINCE_QUERY no longer derives from TEAM_ATTACHMENTS_QUERY');
}
/** The rest of ONE issue's attachments, from the cursor its nested page ended on. */
export const ISSUE_ATTACHMENTS_QUERY = `query IssueAttachments($id: String!, $after: String) { issue(id: $id) { attachments(first: 100, after: $after) { nodes { ${ATTACHMENT_FIELDS} } ${PAGE_INFO} } } }`;

/** Every document in the workspace, as one stream: a document belongs to a project, and a project to teams, so it is placed per team afterwards. */
const DOCUMENT_FIELDS = 'id title url content createdAt updatedAt creator { name } project { id }';
export const DOCUMENTS_QUERY = `query Documents($after: String) { documents(first: ${DOCUMENT_PAGE_SIZE}, after: $after) { nodes { ${DOCUMENT_FIELDS} } ${PAGE_INFO} } }`;
export const DOCUMENTS_SINCE_QUERY = `query DocumentsSince($after: String, $since: DateTimeOrDuration!) { documents(first: ${DOCUMENT_PAGE_SIZE}, after: $after, filter: { updatedAt: { gt: $since } }) { nodes { ${DOCUMENT_FIELDS} } ${PAGE_INFO} } }`;

interface RawAttachment { id: string; title: string | null; subtitle: string | null; url: string; sourceType: string | null; metadata?: unknown; createdAt: string; updatedAt: string }
interface RawIssueWithAttachments { id: string; attachments?: { nodes: RawAttachment[]; pageInfo?: PageInfo } }

/**
 * Every attachment of every issue the team has (or, with `since`, of the issues Linear changed since). Nothing is assumed complete:
 * an issue whose attachment list has no `pageInfo` fails the read, and one with a further page is finished before it is returned.
 * An incremental read sees attachments only on issues Linear changed; the daily full read is what catches the rest (the docs say so).
 */
export async function fetchTeamAttachments(fetcher: LinearFetcher, apiKey: string, team: LinearTeam, opts: { since?: string } = {}): Promise<LinearAttachment[]> {
  const { since } = opts;
  const issues = await pageAll<RawIssueWithAttachments>(
    fetcher, apiKey, since ? TEAM_ATTACHMENTS_SINCE_QUERY : TEAM_ATTACHMENTS_QUERY, since ? { id: team.id, since } : { id: team.id },
    (d: { team: { issues: never } }) => d.team?.issues, `attachments of ${team.key}`,
  );
  const out: LinearAttachment[] = [];
  for (const issue of issues) {
    const list = issue.attachments;
    if (!list || !Array.isArray(list.nodes) || !list.pageInfo) {
      throw new UnprocessableEntityException(`Linear returned no attachment list for an issue of ${team.key} — cannot tell whether its attachments are complete, so nothing was written`);
    }
    for (const a of list.nodes) out.push({ ...a, issueId: issue.id });
    if (list.pageInfo.hasNextPage) {
      if (!list.pageInfo.endCursor) throw new UnprocessableEntityException(`Linear says an issue of ${team.key} has more attachments but gave no cursor — refusing a partial copy`);
      const rest = await pageAll<RawAttachment>(
        fetcher, apiKey, ISSUE_ATTACHMENTS_QUERY, { id: issue.id, after: list.pageInfo.endCursor },
        (d: { issue: { attachments: never } }) => d.issue?.attachments, `more attachments of an issue of ${team.key}`,
      );
      for (const a of rest) out.push({ ...a, issueId: issue.id });
    }
  }
  return out;
}

export async function fetchWorkspaceDocuments(fetcher: LinearFetcher, apiKey: string, opts: { since?: string } = {}): Promise<LinearDocument[]> {
  const { since } = opts;
  return pageAll<LinearDocument>(
    fetcher, apiKey, since ? DOCUMENTS_SINCE_QUERY : DOCUMENTS_QUERY, since ? { since } : {},
    (d: { documents: never }) => d.documents, 'documents',
  );
}

// ───────────────────────────────── what an attachment IS ─────────────────────────────────

export type AttachmentTarget =
  | { kind: 'pull_request'; repo: string; number: number; url: string }
  | { kind: 'link'; url: string }
  | { kind: 'unusable'; reason: string };

/** Far longer than any real link; anything past it is not a link someone meant to keep. */
export const MAX_URL_LENGTH = 2048;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const PULL_PATH = /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,9})(?:\/.*)?$/;

/**
 * Pure, and the ONLY decision about what an attachment becomes. It reads the URL, never Linear's `sourceType`: a person can attach any URL
 * to an issue, so a `github` label proves nothing about where the link goes, and a PR pasted by hand carries no such label at all.
 *
 *  - an https URL on exactly github.com (no credentials, no port) shaped `/owner/repo/pull/N` is a PULL REQUEST, identified by (repo, number);
 *  - any other http(s) URL (a merge commit, a Figma file, a GitHub Enterprise PR) is a plain LINK, kept as given;
 *  - anything else (`javascript:`, `data:`, `file:`, an unparseable string, an absurdly long one) is UNUSABLE: counted and reported, never stored.
 */
export function classifyAttachmentUrl(raw: string): AttachmentTarget {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { kind: 'unusable', reason: 'no URL' };
  if (text.length > MAX_URL_LENGTH) return { kind: 'unusable', reason: `URL longer than ${MAX_URL_LENGTH} characters` };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { kind: 'unusable', reason: 'not a URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'unusable', reason: `${u.protocol.replace(':', '')}: is not an http(s) URL` };
  // The field validator accepts `https?://\S+` only; a URL with whitespace is stored in its normalised form.
  const asGiven = /^https?:\/\/\S+$/i.test(text) ? text : u.href;
  if (u.protocol === 'https:' && GITHUB_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password && u.port === '') {
    const m = PULL_PATH.exec(u.pathname);
    const [owner, name, num] = [m?.[1], m?.[2], m?.[3]];
    if (owner && name && num && owner !== '.' && owner !== '..' && name !== '.' && name !== '..') {
      const number = Number(num);
      if (number > 0) return { kind: 'pull_request', repo: `${owner}/${name}`, number, url: `https://github.com/${owner}/${name}/pull/${number}` };
    }
  }
  return { kind: 'link', url: asGiven };
}

/**
 * The PR state Linear's own attachment metadata can name, when it names one. Linear's GitHub attachment `metadata` is documented loosely, so this
 * reads only a string `status`/`state` of a known value and returns null for everything else: an unknown state is left EMPTY on the PR record,
 * never guessed. (The GitHub webhook fills the real state and branch the moment GitHub sends the PR.)
 */
export function pullStateLabel(metadata: unknown): 'Open' | 'Merged' | 'Closed' | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  const raw = typeof m['status'] === 'string' ? m['status'] : typeof m['state'] === 'string' ? m['state'] : null;
  switch (raw?.toLowerCase()) {
    case 'open': return 'Open';
    case 'merged': return 'Merged';
    case 'closed': return 'Closed';
    default: return null;
  }
}

/** What the attachment is called on the record: Linear's title, else the link itself. Capped; a title is a label, not a document. */
export const MAX_NAME_LENGTH = 300;
export function attachmentName(a: Pick<LinearAttachment, 'title' | 'url'>, fallback: string): string {
  const title = (a.title ?? '').replace(/\s+/g, ' ').trim();
  return (title || fallback).slice(0, MAX_NAME_LENGTH);
}

// ───────────────────────────────── documents ─────────────────────────────────

/** A document body past this is NOT truncated: its record is created without a body and it is named in the run's warnings. Matches the description limit (DocumentsService). */
export const MAX_DOCUMENT_BODY_BYTES = 2 * 1024 * 1024;
export const bodyIsOversize = (markdown: string | null | undefined) => Buffer.byteLength(markdown ?? '', 'utf8') > MAX_DOCUMENT_BODY_BYTES;
/** What the sync stores to tell later whether Linear's text changed: a hash, never a second copy of up to 2 MB. */
export const contentHash = (markdown: string | null | undefined) => createHash('sha256').update(markdown ?? '', 'utf8').digest('hex');

/** The documents whose project is one of this team's projects. A project can span teams, so one document can be selected for several. */
export function documentsForTeam(documents: LinearDocument[], teamProjectIds: ReadonlySet<string>): LinearDocument[] {
  return documents.filter((d) => d.project !== null && teamProjectIds.has(d.project.id));
}

// ───────────────────────────────── the run's own count ─────────────────────────────────

export interface AttachmentTally {
  /** Every attachment Linear returned for the teams read. */
  fetched: number;
  /** Attachments now linked to a PR record in the GitHub Pull Requests database. */
  pull_requests: number;
  /** PR records this run CREATED (the rest already existed, from an earlier run or from the GitHub webhook). */
  pr_records_created: number;
  /** Attachments stored as a record in the team's Links database. */
  links: number;
  /** Of `pull_requests`' kind but kept in the team's Links database because the team's space or database is RESTRICTED: a PR title must not leave it. Included in `links`. */
  kept_in_team_space: number;
  /** A URL that is not http(s), or unusable: counted, listed in `warnings`, never stored. */
  unusable: number;
  /** An attachment on an issue this run did not place (created after the read); the next run picks it up. */
  unplaced: number;
  /** A write that failed (named in `warnings`). The sync continues; the count is what keeps it from looking like a clean run. */
  failed: number;
}

export const emptyAttachmentTally = (): AttachmentTally => ({
  fetched: 0, pull_requests: 0, pr_records_created: 0, links: 0, kept_in_team_space: 0, unusable: 0, unplaced: 0, failed: 0,
});

/** fetched = what became something + what was refused + what failed. A gap means an attachment vanished between the read and the write. */
export function attachmentTallyGap(t: AttachmentTally): number {
  return t.fetched - (t.pull_requests + t.links + t.unusable + t.unplaced + t.failed);
}

export interface DocumentSummary {
  fetched: number;
  /** Distinct Linear documents that now have a record in at least one team's Documents database. */
  placed: number;
  /** Records written across all teams (a document of a project that spans two teams is written once per team database). */
  copies: number;
  created: number;
  body_written: number;
  /** Linear's text changed since the last sync and the StoryOS body was left alone (same rule as an issue description). */
  drift_flagged: number;
  /** Not attached to a project (they hang off an issue, an initiative or nothing): not imported by this ticket. */
  no_project: number;
  /** Attached to a project that is in none of the teams being imported. */
  project_not_imported: number;
  /** Titles of documents whose body is over the limit: the record exists, the body does not. */
  oversize: string[];
  /** Documents whose every attempt failed. */
  failed: number;
}

/** Collects the per-document outcomes of one run across the team loop, then states the totals. */
export class DocumentRun {
  private readonly targeted = new Set<string>();
  private readonly ok = new Map<string, number>();
  copies = 0;
  created = 0;
  bodyWritten = 0;
  drift = 0;
  readonly oversize: string[] = [];
  /** Attachments and PR records resolved once per run, not once per attachment. */
  pullsDb?: { id: string };
  pullStates?: Map<string, string>;
  readonly attachments: AttachmentTally = emptyAttachmentTally();
  readonly warnings: string[] = [];
  private readonly warned = new Map<string, number>();

  constructor(readonly documents: LinearDocument[]) {}

  /** A warning the admin will read, at most MAX_WARNINGS_PER_KIND of each kind; `finish()` says how many more there were. */
  warn(kind: string, message: string) {
    const n = (this.warned.get(kind) ?? 0) + 1;
    this.warned.set(kind, n);
    if (n <= MAX_WARNINGS_PER_KIND) this.warnings.push(message);
  }

  /** The run's warnings, with a closing line for every kind that was cut off. */
  finish(): string[] {
    const more = [...this.warned.entries()].filter(([, n]) => n > MAX_WARNINGS_PER_KIND).map(([kind, n]) => `${kind}: ${n - MAX_WARNINGS_PER_KIND} more not listed (${n} in all)`);
    return [...this.warnings, ...more];
  }

  target(id: string) { this.targeted.add(id); }
  succeeded(id: string) { this.ok.set(id, (this.ok.get(id) ?? 0) + 1); this.copies++; }

  summary(): DocumentSummary {
    let placed = 0;
    let noProject = 0;
    let notImported = 0;
    let failed = 0;
    for (const d of this.documents) {
      if (!d.project) noProject++;
      else if (!this.targeted.has(d.id)) notImported++;
      else if ((this.ok.get(d.id) ?? 0) > 0) placed++;
      else failed++;
    }
    return {
      fetched: this.documents.length, placed, copies: this.copies, created: this.created, body_written: this.bodyWritten, drift_flagged: this.drift,
      no_project: noProject, project_not_imported: notImported, oversize: this.oversize, failed,
    };
  }
}

/** Every document is in exactly one bucket; a gap means one was lost between the read and the write. */
export function documentSummaryGap(s: DocumentSummary): number {
  return s.fetched - (s.placed + s.no_project + s.project_not_imported + s.failed);
}

/** The most warnings one run reports per kind; the count says how many there were. */
export const MAX_WARNINGS_PER_KIND = 20;
