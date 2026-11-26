import { UnprocessableEntityException } from '@nestjs/common';
import { env } from '../../config/env';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, OAuthExchange, ProviderDescriptor } from './types';

/**
 * One Facebook Page the admin granted, with the Page's OWN access token and the Instagram business account linked to it.
 * The token never leaves the sealed blob: the picker returns only `{id, name, type, handle}`, and `connections.scopes` holds the permissions, not the pages.
 */
export interface MetaPage {
  page_id: string;
  name: string;
  page_token: string;
  ig_user_id?: string;
  ig_username?: string;
}

/**
 * The auth JSON sealed for a Meta connection (ticket #51). `user_token` is the LONG-LIVED user token (used to list the
 * pages again); each page carries its own token, which does not expire while the user token's grant stands. There is
 * deliberately NO top-level `expires_at`/`refresh_token`: ConnectionsService's refresh sweep reads those, and Meta has no
 * refresh grant: an invalid token is a 190 on a real call, which flips the connection to `expired` (reconnect).
 */
export interface MetaAuth {
  user_token: string;
  /** Epoch ms the long-lived user token is expected to stop working, when Meta said (about 60 days). Informational. */
  user_token_expires_at?: number;
  obtained_at: number;
  pages: MetaPage[];
}

/** Least privilege: list the pages, read what a page token needs, publish to pages, read the linked IG account, publish to it. */
export const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];

/** The versioned Graph base. One setting (META_GRAPH_VERSION), never a literal at a call site. */
export function metaGraphBase(): string {
  return `https://graph.facebook.com/${env().META_GRAPH_VERSION}`;
}

/** Meta's numeric error code (and subcode) from an error response. Only the numbers: the message can echo post text or a token fragment. */
export async function metaErrorCodes(res: { json: () => Promise<unknown> }): Promise<{ code?: number; subcode?: number }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; error_subcode?: unknown } };
    const code = typeof body?.error?.code === 'number' ? body.error.code : undefined;
    const subcode = typeof body?.error?.error_subcode === 'number' ? body.error.error_subcode : undefined;
    return { code, subcode };
  } catch {
    return {};
  }
}

const SAFE_ID = /^[0-9]{1,30}$/;

interface GraphAccountsResponse {
  data?: {
    id?: unknown;
    name?: unknown;
    access_token?: unknown;
    instagram_business_account?: { id?: unknown; username?: unknown };
  }[];
}

/** `/me/accounts` rows into pages, dropping anything malformed (a page with no token cannot post, so it is not offered). */
export function pagesFromGraph(body: GraphAccountsResponse): MetaPage[] {
  const out: MetaPage[] = [];
  const seen = new Set<string>();
  for (const row of body.data ?? []) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    const token = typeof row.access_token === 'string' ? row.access_token : undefined;
    if (!id || !SAFE_ID.test(id) || !token || seen.has(id)) continue;
    seen.add(id);
    const igId = typeof row.instagram_business_account?.id === 'string' && SAFE_ID.test(row.instagram_business_account.id) ? row.instagram_business_account.id : undefined;
    const igName = typeof row.instagram_business_account?.username === 'string' ? row.instagram_business_account.username : undefined;
    out.push({
      page_id: id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Facebook Page',
      page_token: token,
      ...(igId ? { ig_user_id: igId } : {}),
      ...(igId && igName ? { ig_username: igName } : {}),
    });
  }
  return out;
}

export const ACCOUNTS_FIELDS = 'id,name,access_token,instagram_business_account{id,username}';

/**
 * Meta (Facebook Pages + Instagram business accounts) for post_social (ticket #51). Tier B (`oauth_managed`): hosted
 * StoryOS provides a verified app, a self-managed operator brings their own via META_APP_ID/META_APP_SECRET.
 *
 * The code exchange itself is the generic one; `finishOAuth` then swaps the short-lived user token for a long-lived one
 * and lists the pages the admin granted in Meta's own page-selection dialog. Every post later names ONE of them.
 */
export const metaProvider: ProviderDescriptor = {
  id: 'meta',
  label: 'Facebook & Instagram',
  authKind: 'oauth2',
  tier: 'oauth_managed',
  oauth: {
    authUrl: 'https://www.facebook.com/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/oauth/access_token',
    scopes: META_SCOPES,
    scopeSeparator: ',',
    clientIdEnv: 'META_APP_ID',
    clientSecretEnv: 'META_APP_SECRET',
  },
  // A published post is a public act on a client's brand: a modest per-connection daily ceiling, well under Instagram's own 100 a day.
  rateLimit: { capacity: 50, refillMs: 86_400_000 },
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { user_token } = (auth ?? {}) as Partial<MetaAuth>;
    if (!user_token) throw new UnprocessableEntityException('Meta connection is missing its access token');
    const res = await fetcher(`${metaGraphBase()}/me?fields=id`, { headers: { authorization: `Bearer ${user_token}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`Meta token check failed (HTTP ${res.status})`);
    }
  },
  async finishOAuth(exchange: OAuthExchange, ctx, fetcher) {
    // 1. short-lived user token -> long-lived (about 60 days). The secret goes in the POST body, never a URL.
    const long = await fetcher(`${metaGraphBase()}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: ctx.clientId,
        client_secret: ctx.clientSecret,
        fb_exchange_token: exchange.access_token,
      }).toString(),
    });
    if (long.status < 200 || long.status >= 300) {
      throw new UnprocessableEntityException(`Meta did not extend the connection (HTTP ${long.status}). Try connecting again.`);
    }
    const longBody = (await long.json()) as { access_token?: unknown; expires_in?: unknown };
    const userToken = typeof longBody.access_token === 'string' && longBody.access_token ? longBody.access_token : undefined;
    if (!userToken) throw new UnprocessableEntityException('Meta did not extend the connection. Try connecting again.');
    const now = Date.now();

    // 2. the pages the admin granted, each with its own token. The token travels in a header, not the URL.
    const accounts = await fetcher(`${metaGraphBase()}/me/accounts?fields=${encodeURIComponent(ACCOUNTS_FIELDS)}&limit=100`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    if (accounts.status < 200 || accounts.status >= 300) {
      throw new UnprocessableEntityException(`Meta did not list the pages for this connection (HTTP ${accounts.status}).`);
    }
    const pages = pagesFromGraph((await accounts.json()) as GraphAccountsResponse);
    if (pages.length === 0) {
      throw new UnprocessableEntityException(
        'No Facebook Pages were granted to this connection. Connect again and choose at least one Page you manage.',
      );
    }
    const auth: MetaAuth = {
      user_token: userToken,
      ...(typeof longBody.expires_in === 'number' ? { user_token_expires_at: now + longBody.expires_in * 1000 } : {}),
      obtained_at: now,
      pages,
    };
    return { auth, scopes: META_SCOPES };
  },
};
