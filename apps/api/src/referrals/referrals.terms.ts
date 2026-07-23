/**
 * #33 — plain-text terms shown under Settings → Referrals. Kept as a plain
 * string constant (not a CMS/markdown file) since it's short and versioned
 * with the code that implements it; the API is the one source both the
 * `/referrals/me` response and (via that) the settings page read from.
 */
export const REFERRAL_TERMS =
  'Share your link. When someone signs up through it and their workspace upgrades to a paid ' +
  'plan for the first time, you earn account credit — reviewed and applied by the StoryOS team, ' +
  'not automatic. Self-referrals and repeat attributions for the same account do not qualify. ' +
  'Rewards are credited to your account, not paid out as cash. StoryOS may change or end this ' +
  'program at any time.';
