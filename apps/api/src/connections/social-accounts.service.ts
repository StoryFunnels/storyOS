import { BadGatewayException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { env } from '../config/env';
import { connections } from '../db/schema';
import { ConnectionsService } from './connections.service';
import type { LinkedinAuth } from './providers/linkedin';
import { failClosedFetch } from '../common/test-network-guard';
import type { ConnectionFetcher } from './providers/types';
import type { XAuth } from './providers/x';
import type { MetaAuth } from './providers/meta';
import { ACCOUNTS_FIELDS, metaErrorCodes, metaGraphBase } from './providers/meta';
import type { Membership } from '../workspaces/workspace-access.guard';

/** The LinkedIn API version the posting path pins (see post-social.action.ts); the page list uses the same one. */
const LINKEDIN_API_VERSION = '202401';
const CACHE_TTL_MS = 5 * 60_000;

export type SocialAccountType = 'member' | 'organization' | 'x_account' | 'facebook_page' | 'instagram_business';

/**
 * One account a connection can post as. `id` is what a `post_social` action stores in `account_id` for a LinkedIn
 * page or profile (an organization / person URN). Never a credential, never the raw provider payload.
 */
export interface SocialAccount {
  id: string;
  name: string;
  type: SocialAccountType;
  /** The page's vanity name / the X handle, when the network gave one. */
  handle?: string;
}

export interface SocialAccountList {
  data: SocialAccount[];
  /** Plain sentences about what could not be listed (never raw provider text). */
  warnings: { code: string; message: string }[];
  /** True when this answer came from the short-lived cache rather than a fresh call to the network. */
  cached: boolean;
}

/**
 * Ticket #42 — the company-page picker: which named accounts a social connection can post as, so a person CHOOSES
 * the account a post goes out from instead of the executor guessing (it used to post a "page" post from the member's
 * own profile). Read live from the network with the connection's own credential, cached for a few minutes (a page
 * list changes rarely and the call spends the connection's rate allowance), and never returning anything secret.
 *
 * Permission: the workspace admin, or the person who created the connection. Seeing which pages a connection can
 * publish to is as sensitive as using it, and the existing connection rules already reserve connecting to admins.
 */
@Injectable()
export class SocialAccountsService {
  /** Swappable in tests: the whole provider surface of this service. Nothing in a test ever calls a real network. */
  fetcher: ConnectionFetcher = (url, init) => failClosedFetch()(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body }) as unknown as ReturnType<ConnectionFetcher>;
  private readonly cache = new Map<string, { at: number; list: Omit<SocialAccountList, 'cached'> }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connections: ConnectionsService,
  ) {}

  async list(membership: Membership, userId: string, connectionId: string, refresh = false): Promise<SocialAccountList> {
    // Workspace-scoped lookup first: another workspace's connection is a 404, never a 403 that confirms it exists.
    const row = await this.db.query.connections.findFirst({
      where: and(eq(connections.id, connectionId), eq(connections.workspaceId, membership.workspaceId)),
      columns: { id: true, provider: true, createdBy: true },
    });
    if (!row) throw new NotFoundException('Connection not found');
    if (membership.role !== 'admin' && row.createdBy !== userId) {
      throw new ForbiddenException('Only a workspace admin or the person who connected this account can list the accounts it posts as');
    }
    if (row.provider !== 'linkedin' && row.provider !== 'x' && row.provider !== 'meta') {
      throw new UnprocessableEntityException('This connection does not post to a social network');
    }
    if (row.provider === 'linkedin' && !env().LINKEDIN_ACTIONS_ENABLED) {
      throw new UnprocessableEntityException('LinkedIn publishing is not enabled on this deployment yet');
    }

    if (row.provider === 'meta' && !env().META_ACTIONS_ENABLED) {
      throw new UnprocessableEntityException('Facebook and Instagram publishing is not enabled on this deployment yet');
    }

    const hit = this.cache.get(row.id);
    if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.list, cached: true };

    const { auth } = await this.connections.getDecryptedAuth(membership.workspaceId, row.id);
    const list =
      row.provider === 'x'
        ? await this.listX(auth as Partial<XAuth>)
        : row.provider === 'meta'
          ? await this.listMeta(membership.workspaceId, row.id, auth as Partial<MetaAuth>)
          : await this.listLinkedin(auth as Partial<LinkedinAuth>);
    this.cache.set(row.id, { at: Date.now(), list });
    return { ...list, cached: false };
  }

  private async listLinkedin(auth: Partial<LinkedinAuth>): Promise<Omit<SocialAccountList, 'cached'>> {
    if (!auth.access_token) throw new UnprocessableEntityException('The LinkedIn connection has no access token. Reconnect it.');
    const base = { authorization: `Bearer ${auth.access_token}` };
    const headers = { ...base, 'LinkedIn-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };

    const me = await this.fetcher('https://api.linkedin.com/v2/userinfo', { headers: base });
    if (me.status === 401) throw new UnprocessableEntityException('LinkedIn refused the connection. Reconnect it.');
    if (me.status < 200 || me.status >= 300) throw new BadGatewayException(`LinkedIn refused the profile lookup (HTTP ${me.status})`);
    const profile = (await me.json()) as { sub?: string; name?: string };
    if (!profile.sub) throw new BadGatewayException('LinkedIn did not say which member the connection belongs to');

    const data: SocialAccount[] = [{ id: `urn:li:person:${profile.sub}`, name: profile.name?.trim() || 'LinkedIn profile', type: 'member' }];
    const warnings: SocialAccountList['warnings'] = [];

    const orgs = await this.fetcher(
      'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100&projection=(elements*(organization,organization~(id,localizedName,vanityName)))',
      { headers },
    );
    if (orgs.status === 401 || orgs.status === 403) {
      // The page list needs LinkedIn's restricted organization scopes; a connection granted without them can still post as the member.
      warnings.push({ code: 'organizations_unavailable', message: "LinkedIn did not allow listing this member's company pages. Posting as a page needs the page scopes on the connection." });
    } else if (orgs.status < 200 || orgs.status >= 300) {
      throw new BadGatewayException(`LinkedIn refused the company page lookup (HTTP ${orgs.status})`);
    } else {
      const body = (await orgs.json()) as {
        elements?: { organization?: string; 'organization~'?: { id?: number | string; localizedName?: string; vanityName?: string } }[];
      };
      const seen = new Set<string>();
      for (const el of body.elements ?? []) {
        const detail = el['organization~'];
        const urn = el.organization ?? (detail?.id !== undefined ? `urn:li:organization:${detail.id}` : undefined);
        if (!urn || !/^urn:li:organization:[0-9]+$/.test(urn) || seen.has(urn)) continue;
        seen.add(urn);
        data.push({ id: urn, name: detail?.localizedName?.trim() || 'LinkedIn page', type: 'organization', ...(detail?.vanityName ? { handle: detail.vanityName } : {}) });
      }
    }
    return { data, warnings };
  }

  /**
   * Ticket #51 — the Facebook Pages (and the Instagram business account linked to each) this connection can post as.
   * Asked of Meta LIVE with the connection's user token, then intersected with the pages whose own tokens are sealed on
   * the connection: a Page can only be posted to if we hold its token, and a Page that was de-authorized since connecting
   * is a warning, never an option. The id a person picks is what `post_social` stores in `account_id`; tokens never leave.
   */
  private async listMeta(workspaceId: string, connectionId: string, auth: Partial<MetaAuth>): Promise<Omit<SocialAccountList, 'cached'>> {
    if (!auth.user_token || !Array.isArray(auth.pages)) throw new UnprocessableEntityException('The Meta connection has no access token. Reconnect it.');
    const res = await this.fetcher(`${metaGraphBase()}/me/accounts?fields=${encodeURIComponent(ACCOUNTS_FIELDS.replace('access_token,', ''))}&limit=100`, {
      headers: { authorization: `Bearer ${auth.user_token}` },
    });
    if (res.status < 200 || res.status >= 300) {
      const { code } = await metaErrorCodes(res);
      if (code === 190 || res.status === 401) {
        await this.connections.flagReconnectRequired(workspaceId, connectionId);
        throw new UnprocessableEntityException('Meta no longer accepts this connection. Reconnect it.');
      }
      throw new BadGatewayException(`Meta refused the Page lookup (HTTP ${res.status})`);
    }
    const body = (await res.json()) as { data?: { id?: unknown; name?: unknown; instagram_business_account?: { id?: unknown; username?: unknown } }[] };
    const live = new Map<string, { name?: string; igId?: string; igName?: string }>();
    for (const row of body.data ?? []) {
      if (typeof row.id !== 'string') continue;
      live.set(row.id, {
        name: typeof row.name === 'string' ? row.name : undefined,
        igId: typeof row.instagram_business_account?.id === 'string' ? row.instagram_business_account.id : undefined,
        igName: typeof row.instagram_business_account?.username === 'string' ? row.instagram_business_account.username : undefined,
      });
    }
    const data: SocialAccount[] = [];
    let missing = 0;
    for (const page of auth.pages) {
      const hit = live.get(page.page_id);
      if (!hit) {
        missing += 1;
        continue;
      }
      data.push({ id: page.page_id, name: hit.name?.trim() || page.name, type: 'facebook_page' });
      // Only an Instagram account that is STILL linked to this Page, and that we hold a token for (the Page's), is offered.
      if (page.ig_user_id && hit.igId === page.ig_user_id) {
        const handle = hit.igName ?? page.ig_username;
        data.push({ id: page.ig_user_id, name: handle ? `@${handle}` : 'Instagram account', type: 'instagram_business', ...(handle ? { handle } : {}) });
      }
    }
    const warnings: SocialAccountList['warnings'] = [];
    if (missing > 0) {
      warnings.push({
        code: 'pages_unavailable',
        message: `${missing} Page${missing === 1 ? '' : 's'} granted earlier ${missing === 1 ? 'is' : 'are'} no longer available to this connection. Reconnect to choose again.`,
      });
    }
    return { data, warnings };
  }

  private async listX(auth: Partial<XAuth>): Promise<Omit<SocialAccountList, 'cached'>> {
    if (!auth.access_token) throw new UnprocessableEntityException('The X connection has no access token. Reconnect it.');
    const res = await this.fetcher('https://api.twitter.com/2/users/me', { headers: { authorization: `Bearer ${auth.access_token}` } });
    if (res.status === 401) throw new UnprocessableEntityException('X refused the connection. Reconnect it.');
    if (res.status < 200 || res.status >= 300) throw new BadGatewayException(`X refused the account lookup (HTTP ${res.status})`);
    const body = (await res.json()) as { data?: { id?: string; name?: string; username?: string } };
    if (!body.data?.id) throw new BadGatewayException('X did not say which account the connection belongs to');
    const handle = body.data.username;
    return {
      data: [{ id: body.data.id, name: handle ? `@${handle}` : body.data.name?.trim() || 'X account', type: 'x_account', ...(handle ? { handle } : {}) }],
      warnings: [],
    };
  }
}
