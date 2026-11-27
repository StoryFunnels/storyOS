import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, records, selectOptions, spaces } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { env } from '../config/env';
import { AccessService, spaceCanHoldDatabases } from '../access/access.service';
import { looksLikeUuid } from '../common/uuid';
import { escapeSlackText } from './slack.service';
import { parseRecordLink } from './slack-record-link';
import { SlackApiClient, SLACK_INSTALLATION_PROVIDER } from './slack-installations';
import type { SlackInstallationProvider } from './slack-installations';

/** The part of a `link_shared` event this service reads. Everything is `unknown` until checked: it is Slack's JSON, signed, but ours to distrust. */
export interface LinkSharedEvent {
  /** The Slack workspace the app is installed in: the envelope's `team_id`, NOT anything inside a link. */
  teamId: unknown;
  channel?: unknown;
  messageTs?: unknown;
  source?: unknown;
  unfurlId?: unknown;
  links?: unknown;
}

/** What one event did. Internal (tests, logs): the HTTP answer is the same constant whatever happened, so it never reveals why. */
export type UnfurlOutcome =
  | { unfurled: number; skipped?: undefined }
  | { unfurled: 0; skipped: 'no_team' | 'no_installation' | 'no_links' | 'nothing_to_show' | 'no_target' | 'slack_error' };

/** What a preview may carry. Two strings. Anything else is a bug here, so there is no field for it to arrive in. */
export interface RecordPreview {
  title: string;
  state: string | null;
}

const MAX_LINKS = 10;
const TITLE_MAX = 150;
const STATE_MAX = 80;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Ticket #1379 - what Slack shows under a pasted StoryOS record link: the record's TITLE and its STATE, and nothing else (Otto's
 * ruling on ticket #1369: no field content, no description, no assignee, no comments, no identifier beyond what the link itself says).
 * Every person-typed string is escaped for Slack, so a title carrying `<!channel>` arrives as literal text and pings nobody.
 */
export function buildUnfurl(preview: RecordPreview): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlackText(oneLine(preview.title, TITLE_MAX) || 'Untitled')}*` } },
  ];
  if (preview.state) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `State: *${escapeSlackText(oneLine(preview.state, STATE_MAX))}*` }] });
  }
  return { blocks };
}

/**
 * Ticket #1379 - the link-preview decision and the call that carries it out.
 *
 * WHO MAY SEE A PREVIEW is not the person who pasted the link: Slack tells us who pasted it, never who they are in StoryOS, so no
 * per-person access check is possible and none is faked. The rule is therefore about the OBJECT, and it is the strictest one the
 * product already has for "post to a place whose readers StoryOS does not control" (ADR-0018 section 9, ticket #880):
 *
 *   a preview exists ONLY IF all of these hold, and every other case is the same silence:
 *   - the Slack team is one a StoryOS workspace installed (`SlackInstallationProvider`), and the link is into THAT workspace;
 *   - the record, its database and its space are all live (not trashed) and the space is not personal;
 *   - the database is not a SYSTEM database (the Members directory is people's names);
 *   - the database and its space are both OPEN TO EVERY MEMBER (not restricted): a restricted record's title never goes to a
 *     channel, by an unauthenticated outsider's paste, on any account.
 *
 * "No such record", "wrong workspace", "trashed", "restricted", "system" and "personal" are one code path that returns null and
 * posts nothing, so the Slack user (and anyone timing us) cannot tell a hidden record from one that does not exist.
 */
@Injectable()
export class SlackUnfurlService {
  private readonly logger = new Logger(SlackUnfurlService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly client: SlackApiClient,
    @Inject(SLACK_INSTALLATION_PROVIDER) private readonly installations: SlackInstallationProvider,
  ) {}

  async handleLinkShared(event: LinkSharedEvent): Promise<UnfurlOutcome> {
    if (typeof event.teamId !== 'string' || !event.teamId) return { unfurled: 0, skipped: 'no_team' };
    const installation = await this.installations.findByTeamId(event.teamId);
    // A link pasted in ANY other Slack workspace gets nothing: that workspace did not install us here.
    if (!installation) return { unfurled: 0, skipped: 'no_installation' };

    const urls = this.urlsOf(event.links);
    if (urls.length === 0) return { unfurled: 0, skipped: 'no_links' };

    const unfurls: Record<string, unknown> = {};
    for (const url of urls) {
      const link = parseRecordLink(url, env().WEB_URL);
      // A link into a different StoryOS workspace is the same silence as a record that does not exist.
      if (!link || link.workspaceId !== installation.workspaceId) continue;
      const preview = await this.previewFor(installation.workspaceId, link.databaseId, link.recordRef);
      if (preview) unfurls[url] = buildUnfurl(preview);
    }
    if (Object.keys(unfurls).length === 0) return { unfurled: 0, skipped: 'nothing_to_show' };

    const target = this.targetOf(event);
    if (!target) return { unfurled: 0, skipped: 'no_target' };
    const res = await this.client.call('chat.unfurl', installation.botToken, { ...target, unfurls });
    if (!res.ok) {
      // The Slack error CODE only (`cannot_unfurl_url`, `invalid_auth`): never a body, never the token.
      this.logger.warn(`chat.unfurl failed: ${res.error}`);
      return { unfurled: 0, skipped: 'slack_error' };
    }
    return { unfurled: Object.keys(unfurls).length };
  }

  /** The links of the event, as a deduped, bounded list of strings. Anything that is not `{ url: string }` is dropped. */
  private urlsOf(links: unknown): string[] {
    if (!Array.isArray(links)) return [];
    const urls = new Set<string>();
    for (const l of links) {
      const url = l && typeof l === 'object' ? (l as { url?: unknown }).url : undefined;
      if (typeof url === 'string' && url.length > 0 && url.length <= 2048) urls.add(url);
      if (urls.size >= MAX_LINKS) break;
    }
    return [...urls];
  }

  /** Where Slack wants the unfurl: the posted message (`channel` + `ts`), or the composer draft (`unfurl_id` + `source`). */
  private targetOf(event: LinkSharedEvent): Record<string, string> | null {
    if (event.source === 'composer') {
      return typeof event.unfurlId === 'string' && event.unfurlId ? { unfurl_id: event.unfurlId, source: 'composer' } : null;
    }
    if (typeof event.channel === 'string' && event.channel && typeof event.messageTs === 'string' && event.messageTs) {
      return { channel: event.channel, ts: event.messageTs };
    }
    return null;
  }

  /** The title and state of the record named by a link, or null. THE rule above, in order; null is the only way to say no. */
  async previewFor(workspaceId: string, databaseId: string, recordRef: string): Promise<RecordPreview | null> {
    const database = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, databaseId), eq(databases.workspaceId, workspaceId), notDeleted(databases.deletedAt)),
    });
    if (!database || database.isSystem) return null;
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, database.spaceId), eq(spaces.workspaceId, workspaceId), notDeleted(spaces.deletedAt)),
    });
    if (!space || !spaceCanHoldDatabases(space)) return null;
    // The ONE predicate for "open to every member" (ADR-0018): the database or its space restricted means closed. Not re-derived here.
    if (await this.access.isClosedToSomeMembers(workspaceId, database.id)) return null;

    const record = await this.db.query.records.findFirst({
      where: and(
        eq(records.databaseId, database.id),
        notDeleted(records.deletedAt),
        looksLikeUuid(recordRef) ? eq(records.id, recordRef) : eq(records.number, Number(recordRef)),
      ),
    });
    if (!record) return null;

    // `title_local` is the title as someone WITHOUT access to the record's cross-record inputs sees it (ticket #884): a preview is
    // read by exactly such a person, so it is the only title that may leave.
    const title = (record.titleLocal ?? record.title).trim();
    return { title, state: await this.stateOf(database.id, record.values as Record<string, unknown>) };
  }

  /**
   * The record's state label: the value of its database's STATUS field (its workflow field, else the single-select named State or
   * Status). Null when the database has neither or the record has no value. The same field ticket #1377's channel subscriptions
   * call the status; one resolver should serve both once both have landed.
   */
  private async stateOf(databaseId: string, values: Record<string, unknown>): Promise<string | null> {
    const defs = await this.db.query.fields.findMany({ where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)) });
    const field =
      defs.find((f) => f.type === 'workflow') ?? defs.find((f) => f.type === 'select' && ['state', 'status'].includes(f.apiName.toLowerCase()));
    if (!field) return null;
    const optionId = values[field.id];
    if (typeof optionId !== 'string') return null;
    const option = await this.db.query.selectOptions.findFirst({ where: and(eq(selectOptions.id, optionId), eq(selectOptions.fieldId, field.id)) });
    return option?.label ?? null;
  }
}
