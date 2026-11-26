import { env } from '../config/env';
import { YOUTUBE_CHANNEL_ID } from '../connections/providers/youtube';
import type { AutomationAction } from '@storyos/schemas';

type PostSocialAction = Extract<AutomationAction, { type: 'post_social' }>;
export type SocialTarget = PostSocialAction['target'];
/** The network a post goes to. A LinkedIn profile and a LinkedIn page are both `linkedin`; `target` tells them apart. */
export type SocialChannel = 'linkedin' | 'x' | 'facebook' | 'instagram' | 'youtube';
export type SocialProvider = 'linkedin' | 'x' | 'meta' | 'youtube';

/** A LinkedIn page is named by its organization URN, and only by that. */
export const LINKEDIN_ORG_URN = /^urn:li:organization:[0-9]+$/;
export const LINKEDIN_PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]+$/;
/** A Facebook Page id and an Instagram business account id are numeric Graph ids. */
export const META_NUMERIC_ID = /^[0-9]{1,30}$/;
export { YOUTUBE_CHANNEL_ID };

interface TargetInfo {
  provider: SocialProvider;
  channel: SocialChannel;
  /** The deployment kill-switch that must be on before this target can be saved or run, if any. */
  gate: 'LINKEDIN_ACTIONS_ENABLED' | 'META_ACTIONS_ENABLED' | 'YOUTUBE_ACTIONS_ENABLED' | null;
  /** What a person is told when the gate is off. */
  gateMessage: string;
}

/**
 * Ticket #51 — the ONE place that says what each post_social target is: which connection provider it needs, which network
 * it is, which deployment switch gates it, and what "names its account" means. Before this, the same facts were re-cased
 * in the save-time validator, the executor, the publish-state read and the retry, and a fourth and fifth target would have
 * drifted them apart. Everything that asks "which provider?" or "does this name an account?" asks here.
 */
export const SOCIAL_TARGETS: Record<SocialTarget, TargetInfo> = {
  linkedin_org: { provider: 'linkedin', channel: 'linkedin', gate: 'LINKEDIN_ACTIONS_ENABLED', gateMessage: 'LinkedIn publishing is not enabled on this deployment yet.' },
  linkedin_member: { provider: 'linkedin', channel: 'linkedin', gate: 'LINKEDIN_ACTIONS_ENABLED', gateMessage: 'LinkedIn publishing is not enabled on this deployment yet.' },
  x: { provider: 'x', channel: 'x', gate: null, gateMessage: '' },
  facebook_page: { provider: 'meta', channel: 'facebook', gate: 'META_ACTIONS_ENABLED', gateMessage: 'Facebook and Instagram publishing is not enabled on this deployment yet.' },
  instagram_business: { provider: 'meta', channel: 'instagram', gate: 'META_ACTIONS_ENABLED', gateMessage: 'Facebook and Instagram publishing is not enabled on this deployment yet.' },
  youtube_channel: { provider: 'youtube', channel: 'youtube', gate: 'YOUTUBE_ACTIONS_ENABLED', gateMessage: 'YouTube publishing is not enabled on this deployment yet.' },
};

export function isSocialTarget(value: unknown): value is SocialTarget {
  return typeof value === 'string' && Object.hasOwn(SOCIAL_TARGETS, value);
}

export function channelOfTarget(target: string | undefined): SocialChannel {
  return isSocialTarget(target) ? SOCIAL_TARGETS[target].channel : 'x';
}

/** Is this target switched on for this deployment (the kill-switch of its network)? `x` has none. */
export function targetEnabled(target: SocialTarget): boolean {
  const gate = SOCIAL_TARGETS[target].gate;
  return gate === null ? true : env()[gate];
}

/**
 * Whether the action names the account it posts as. NOTHING POSTS FROM AN UNNAMED ACCOUNT (#42, #51): a LinkedIn page, a
 * Facebook Page, an Instagram business account and a YouTube channel each REQUIRE one; a LinkedIn member may pin the member; X has no
 * sub-account to name.
 */
export function namesAccount(action: { target?: string; account_id?: string }): boolean {
  const id = action.account_id;
  switch (action.target) {
    case 'linkedin_org':
      return !!id && LINKEDIN_ORG_URN.test(id);
    case 'linkedin_member':
      return !id || LINKEDIN_PERSON_URN.test(id);
    case 'facebook_page':
    case 'instagram_business':
      return !!id && META_NUMERIC_ID.test(id);
    case 'youtube_channel':
      return !!id && YOUTUBE_CHANNEL_ID.test(id);
    case 'x':
      return !id;
    default:
      return false;
  }
}
