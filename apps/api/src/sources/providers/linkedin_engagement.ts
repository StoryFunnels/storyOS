import { z } from 'zod';
import { UnprocessableEntityException } from '@nestjs/common';
import { env } from '../../config/env';
import type { HttpConnectionAuth } from '../../connections/providers/http';
import type { ConnectionFetcher } from '../../connections/providers/types';
import type { SourceProviderDescriptor, SourceSyncContext } from './types';
import type { EngagementItem } from './engagement';

/**
 * MN-261 — LinkedIn org-post comments, the weakest of the three social APIs
 * (ticket's own words) and the one to SHIP LAST: `r_organization_social` is a
 * restricted-review LinkedIn Partner Program scope, same app-review gate
 * MN-257's post_social executor will need. `LINKEDIN_ACTIONS_ENABLED`
 * (config/env.ts) is OFF by default — this provider is registered (so its
 * config validates and every test below runs against mocked fetchers with no
 * real network) but `sync()` refuses to call out until an operator has
 * actually cleared review and flips the flag.
 *
 * There is also no `linkedin` (or any) discovery API wired up for "this org's
 * recent posts" — `socialActions/{postUrn}/comments` needs a postUrn, and
 * finding org postUrns automatically is a separate, larger piece of work.
 * `post_urns` is therefore an explicit config list (same shape as
 * youtube.ts's metrics `video_ids`), not auto-discovered — a real caveat the
 * connect UI copy should state plainly, per the ticket's AC.
 *
 * Connection: no dedicated 'linkedin' OAuth connection provider exists yet
 * (verified against connections/providers/index.ts) — this runs against the
 * generic 'http' bearer connection, same pattern as meta_engagement.ts /
 * x_engagement.ts.
 */

const API_BASE = 'https://api.linkedin.com/rest';
const PAGE_SIZE = 50;
const MAX_PAGES_PER_POST = 10;

export const linkedinEngagementConfigSchema = z.object({
  post_urns: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe('LinkedIn post/share URNs to poll comments for, e.g. "urn:li:share:123" — not auto-discovered.'),
});

function bearerTokenOf(auth: unknown): string {
  const a = (auth ?? {}) as Partial<HttpConnectionAuth>;
  if (a.auth_style !== 'bearer' || !a.token?.trim()) {
    throw new UnprocessableEntityException(
      'linkedin.org_engagement needs an "http" connection with auth_style: "bearer" (a LinkedIn org access token)',
    );
  }
  return a.token;
}

function toIso(epochMs: unknown): string | null {
  if (typeof epochMs !== 'number') return null;
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function liGet(
  fetcher: ConnectionFetcher,
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetcher(`${API_BASE}/${path}?${qs}`, {
    headers: { authorization: `Bearer ${token}`, 'LinkedIn-Version': '202401' },
  });
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`LinkedIn API ${path} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function syncPostComments(
  fetcher: ConnectionFetcher,
  token: string,
  postUrn: string,
  watermark: string | undefined,
  emit: (items: EngagementItem[]) => Promise<void>,
): Promise<string | null> {
  let maxSeen = watermark ?? null;
  let start = 0;
  let pagesWalked = 0;

  for (;;) {
    const page = await liGet(fetcher, token, `socialActions/${encodeURIComponent(postUrn)}/comments`, {
      count: String(PAGE_SIZE),
      start: String(start),
    });
    const elements = (page['elements'] as Array<Record<string, unknown>> | undefined) ?? [];
    const batch: EngagementItem[] = [];

    for (const el of elements) {
      const created = (el['created'] as Record<string, unknown> | undefined)?.['time'];
      const createdAt = toIso(created);
      if (watermark && createdAt && createdAt <= watermark) continue;
      const parentComment = el['parentComment'] as string | undefined;
      batch.push({
        provider: 'linkedin.org_engagement',
        kind: parentComment ? 'reply' : 'comment',
        external_id: String(el['id']),
        author_handle: null, // LinkedIn exposes an actor URN, never a handle
        author_name: null, // resolving actor → display name is a separate profile-lookup call
        text: ((el['message'] as Record<string, unknown> | undefined)?.['text'] as string | undefined) ?? '',
        permalink: null, // this API doesn't return a per-comment permalink
        parent_external_id: parentComment ?? null,
        post_external_id: postUrn,
        posted_at: createdAt,
      });
      if (createdAt && (!maxSeen || createdAt > maxSeen)) maxSeen = createdAt;
    }

    if (batch.length) await emit(batch);

    const total = (page['paging'] as Record<string, unknown> | undefined)?.['total'] as number | undefined;
    start += elements.length;
    pagesWalked += 1;
    if (elements.length < PAGE_SIZE || (total !== undefined && start >= total) || pagesWalked >= MAX_PAGES_PER_POST) {
      break;
    }
  }

  return maxSeen;
}

export const linkedinEngagementProvider: SourceProviderDescriptor = {
  id: 'linkedin.org_engagement',
  label: 'LinkedIn — org post comments',
  connectionProvider: 'http',
  configSchema: linkedinEngagementConfigSchema,
  async sync(ctx: SourceSyncContext) {
    if (!env().LINKEDIN_ACTIONS_ENABLED) {
      throw new UnprocessableEntityException(
        'linkedin.org_engagement is disabled — LINKEDIN_ACTIONS_ENABLED is off until LinkedIn app review clears',
      );
    }
    const token = bearerTokenOf(ctx.auth);
    const postUrns = (ctx.config['post_urns'] as string[] | undefined) ?? [];
    const watermarks = { ...((ctx.cursor['watermarks'] as Record<string, string> | undefined) ?? {}) };
    const emit = (items: EngagementItem[]) => ctx.emit(items as unknown as Array<Record<string, unknown>>);

    for (const postUrn of postUrns) {
      const next = await syncPostComments(ctx.fetcher, token, postUrn, watermarks[postUrn], emit);
      if (next) watermarks[postUrn] = next;
    }

    return { cursor: { watermarks } };
  },
};
