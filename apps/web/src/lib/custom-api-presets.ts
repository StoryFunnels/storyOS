import { SOCIAL_INGEST, type SocialIngestId } from '@/lib/social-ingest';

/**
 * Ticket #1188 (Ievgen's ruling on ticket #974, 27 Oct): Meta, X and LinkedIn are PRESETS of a Custom API connection, not providers.
 * They only ever made a generic HTTP connection, found again by NAME (`SOCIAL_INGEST[...].connectionMatch`, mirrored on the server in
 * `integration-registry.ts`), so nothing about how they are stored changes: a preset only pre-fills the connect form, and a saved
 * connection is recognised as a preset by the same name rule it always was. No stored `provider` value changes, so no migration and
 * no API change; every connection made before this ticket keeps working because its row is untouched.
 *
 * Each base URL below is the API root the platform's own source adapter already calls (`apps/api/src/sources/providers/*_engagement.ts`),
 * so the credential is allowed to go exactly where the sync sends it, and nowhere else (the #1035 rule).
 */
export type CustomApiPresetId = SocialIngestId;

export interface CustomApiPreset {
  id: CustomApiPresetId;
  label: string;
  /** The connection name the preset pre-fills. It is also what makes the connection recognisable as this preset (`connectionMatch`). */
  defaultName: string;
  baseUrl: string;
  authStyle: 'bearer';
  /** One sentence on what to paste into the token field. Never a credential. */
  tokenHint: string;
  docsUrl: string;
  /** What the connection is used for once saved: the source that reads from it. */
  sourceProvider: string;
}

export const CUSTOM_API_PRESETS: ReadonlyArray<CustomApiPreset> = [
  {
    id: 'meta',
    label: 'Meta (Facebook & Instagram)',
    defaultName: SOCIAL_INGEST.meta.defaultConnectionName,
    baseUrl: 'https://graph.facebook.com/v19.0',
    authStyle: 'bearer',
    tokenHint: 'A long-lived Page access token with the pages_read_engagement permission.',
    docsUrl: 'https://developers.facebook.com/docs/graph-api',
    sourceProvider: SOCIAL_INGEST.meta.sourceProvider,
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    defaultName: SOCIAL_INGEST.x.defaultConnectionName,
    baseUrl: 'https://api.twitter.com/2',
    authStyle: 'bearer',
    tokenHint: 'An OAuth 2.0 user token with the tweet.read and users.read scopes.',
    docsUrl: 'https://developer.x.com/en/docs/x-api',
    sourceProvider: SOCIAL_INGEST.x.sourceProvider,
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    defaultName: SOCIAL_INGEST.linkedin.defaultConnectionName,
    baseUrl: 'https://api.linkedin.com/rest',
    authStyle: 'bearer',
    tokenHint: 'An organization access token with the r_organization_social scope.',
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/',
    sourceProvider: SOCIAL_INGEST.linkedin.sourceProvider,
  },
];

export function customApiPreset(id: string | null | undefined): CustomApiPreset | null {
  return CUSTOM_API_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Which preset a SAVED connection is, by the rule that has always identified it: a generic HTTP connection whose name starts with the
 * platform. Anything that is not an HTTP connection, or has any other name, is plain Custom API. Pure, so the mapping of existing
 * stored kinds is tested rather than assumed.
 */
export function presetForConnection(c: { provider: string; name: string }): CustomApiPreset | null {
  if (c.provider !== 'http') return null;
  return CUSTOM_API_PRESETS.find((p) => SOCIAL_INGEST[p.id].connectionMatch.test(c.name)) ?? null;
}
