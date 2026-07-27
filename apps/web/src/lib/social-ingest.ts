/**
 * #112 — the social engagement ingest platforms (Meta / X / LinkedIn) that a
 * user can set up from the integrations gallery instead of having to already be
 * inside a database's "Sync from…" menu.
 *
 * `defaultConnectionName` / `connectionMatch` MIRROR the server
 * (apps/api/src/integrations/integration-registry.ts `SOCIAL_INGEST`) — the
 * setup page seeds the connection name so it's identifiable per-platform and the
 * server resolves "connected" from that same naming. Keep the two in sync.
 */

export type SocialIngestId = 'meta' | 'x' | 'linkedin';

export interface SocialIngestConfig {
  id: SocialIngestId;
  label: string;
  /** The source provider this platform's records come from (sources dialog). */
  sourceProvider: string;
  /** Seeded name for the http bearer connection this platform uses. */
  defaultConnectionName: string;
  /** Recognizes an existing connection as belonging to this platform. */
  connectionMatch: RegExp;
  blurb: string;
  /** How to mint the token + where to find the ids the source config asks for. */
  tokenSteps: string[];
}

export const SOCIAL_INGEST: Record<SocialIngestId, SocialIngestConfig> = {
  meta: {
    id: 'meta',
    label: 'Meta (Facebook & Instagram)',
    sourceProvider: 'meta.page_comments',
    defaultConnectionName: 'Meta comments',
    connectionMatch: /^meta\b/i,
    blurb: 'Pull Facebook Page and Instagram comments into a StoryOS database as records.',
    tokenSteps: [
      'In Meta\'s developer tools, mint a long-lived Page Access Token (or a System User token scoped to the Page) with the pages_read_engagement permission.',
      'Add it below as a "bearer" HTTP connection — the name is pre-filled so it stays identifiable.',
      'In the source config, leave Page ID blank to use the token\'s own Page. Add the paired Instagram Business Account ID (Meta Business Suite) to also pull Instagram comments.',
    ],
  },
  x: {
    id: 'x',
    label: 'X (Twitter)',
    sourceProvider: 'x.mentions',
    defaultConnectionName: 'X mentions',
    connectionMatch: /^x\b/i,
    blurb: 'Pull mentions of your X account into a StoryOS database as records.',
    tokenSteps: [
      'In X\'s developer portal, create an OAuth 2.0 user token with the tweet.read and users.read scopes.',
      'Add it below as a "bearer" HTTP connection.',
      'In the source config, leave User ID blank to track the connected account\'s own mentions. Lookback and volume follow the account\'s X API plan.',
    ],
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    sourceProvider: 'linkedin.org_engagement',
    defaultConnectionName: 'LinkedIn comments',
    connectionMatch: /^linkedin\b/i,
    blurb: 'Pull comments on your LinkedIn organization posts into a StoryOS database.',
    tokenSteps: [
      'Obtain a LinkedIn organization access token with the r_organization_social scope (granted through LinkedIn\'s Partner Program review).',
      'Add it below as a "bearer" HTTP connection.',
      'In the source config, paste one share/UGC URN per line, e.g. urn:li:share:123. Post URNs are not auto-discovered. Syncing stays off until an operator enables LinkedIn actions on the server.',
    ],
  },
};
