import { z } from 'zod';

/**
 * Ticket #456 - the guided "Turn on publishing" flow for the Social Command Center pack.
 *
 * Three calls, one database (the pack's Posts database):
 *   GET  /workspaces/{ws}/databases/{db}/publishing          what is set up, what blocks turning it on, the rule to create
 *   POST /workspaces/{ws}/databases/{db}/publishing/enable   create (or re-enable) the publish rule for ONE network
 *   POST /workspaces/{ws}/databases/{db}/publishing/disable  pause every publish rule on the database
 *
 * Nothing here posts. Enabling saves a rule; the rule posts only when a post's Status later becomes Scheduled, and (unless an admin
 * turned approval off) only after a person approves the exact text and account.
 */

/** The three places a post can go out as; LinkedIn page and profile share one connection provider, X has its own. */
export const PUBLISH_TARGETS = ['linkedin_org', 'linkedin_member', 'x'] as const;
export type PublishTarget = (typeof PUBLISH_TARGETS)[number];

/**
 * Every reason the enable call can refuse, as a stable code the web branches on. `enable` answers 422 with the full list (never just
 * the first), so a person fixes everything in one pass; `GET` reports the ones that do not depend on the chosen connection/account.
 *
 *   not_applicable             this database is not the Posts database of an installed Social Command Center
 *   field_missing              Status, Text, Media or Post URL is gone or no longer has its original type (`field` says which)
 *   scheduled_option_missing   Status has no "Scheduled" option any more
 *   connection_missing         no such connection in this workspace
 *   connection_wrong_provider  the connection is not a LinkedIn connection (for a LinkedIn target) or an X connection (for x)
 *   provider_not_switched_on   LinkedIn posting is not switched on for this deployment (it waits on LinkedIn's app review)
 *   account_required           a LinkedIn page must be named: an organization URN from the connection's social accounts
 *   account_not_found          the named account is not one this connection can post as
 *   accounts_unavailable       the network could not be asked which accounts the connection can post as; nothing is assumed
 *   approval_off_needs_admin   only a workspace admin, typing it themselves, may turn approval off
 *   already_configured         a publish rule for this network already exists with a different connection or account
 */
export const PUBLISHING_UNMET_CODES = [
  'not_applicable',
  'field_missing',
  'scheduled_option_missing',
  'connection_missing',
  'connection_wrong_provider',
  'provider_not_switched_on',
  'account_required',
  'account_not_found',
  'accounts_unavailable',
  'approval_off_needs_admin',
  'already_configured',
] as const;
export type PublishingUnmetCode = (typeof PUBLISHING_UNMET_CODES)[number];

export const publishingUnmetSchema = z.object({
  code: z.enum(PUBLISHING_UNMET_CODES),
  /** A plain sentence safe to show a person. Never provider text. */
  message: z.string(),
  target: z.enum(PUBLISH_TARGETS).optional(),
  /** For `field_missing`: which of the pack's fields (status, text, media, post_url). */
  field: z.string().optional(),
});
export type PublishingUnmet = z.infer<typeof publishingUnmetSchema>;

export const enablePublishingSchema = z.object({
  connection_id: z.uuid(),
  target: z.enum(PUBLISH_TARGETS),
  /**
   * The named account: required for `linkedin_org` (an organization URN, picked from GET /connections/{id}/social-accounts), optional for
   * `linkedin_member` (the member URN, to pin it), not used for `x` (an X connection IS one account). It is checked against that list.
   */
  account_id: z.string().min(1).max(200).optional(),
  /** Defaults to true. `false` (post without asking) is a workspace admin's decision, typed by that admin. */
  require_approval: z.boolean().optional(),
});
export type EnablePublishingInput = z.infer<typeof enablePublishingSchema>;

export const disablePublishingSchema = z.object({
  /** Pause only this network's rule; omit to pause every publish rule on the database. */
  target: z.enum(PUBLISH_TARGETS).optional(),
});
export type DisablePublishingInput = z.infer<typeof disablePublishingSchema>;

/** One publish rule on the Posts database, as the setup card shows it. */
export type PublishingRule = {
  id: string;
  enabled: boolean;
  name: string;
  target: PublishTarget;
  connection_id: string;
  /** The named account the rule posts as (null for `x`, whose account is the connection's own, and for an unpinned member post). */
  account_id: string | null;
  require_approval: boolean;
  /** Who saved the rule (a member's user id) and when. */
  created_by: string | null;
  created_at: string;
  /** Who last turned it on, and when, from the audit trail; null when it has only ever been created switched on by the call that made it. */
  enabled_by: string | null;
  enabled_at: string | null;
};

export type PublishingChannel = {
  /** The connection provider id: 'linkedin' or 'x'. */
  provider: 'linkedin' | 'x';
  /** From the deployment's provider rules (tier + hosted/self-managed + the operator's OAuth env): connectable, operator_config or cloud_only. */
  availability: 'connectable' | 'operator_config' | 'cloud_only';
  /** False while LinkedIn posting is not switched on for this deployment: the connect button may exist, the posting step may not. */
  posting_enabled: boolean;
  /** The targets this channel offers: LinkedIn page and profile, or X. */
  targets: PublishTarget[];
  /** Connections of this provider already in the workspace (never any credential). */
  connections: { id: string; name: string; status: string; created_by: string | null }[];
};

export type PublishingSetup = {
  /** Is this the Posts database of an installed Social Command Center? When false nothing below is filled in. */
  applicable: boolean;
  /** `off`: no publish rule. `paused`: rules exist, none enabled. `on`: at least one enabled. */
  state: 'not_set_up' | 'paused' | 'on';
  /** Whether the caller may turn publishing on or off here. When false the rest is withheld (an `Ask an admin` card needs only this). */
  can_manage: boolean;
  /** Whether the caller may switch approval off (a workspace admin, in a browser session). */
  can_skip_approval: boolean;
  rules: PublishingRule[];
  channels: PublishingChannel[];
  /** What blocks turning publishing on regardless of which connection is chosen (a renamed-away field, a missing option). */
  unmet: PublishingUnmet[];
  /** The ids the rule is built from, resolved once on the server so no client matches fields by name. Null when `unmet` has a field problem. */
  fields: {
    status_field_id: string;
    scheduled_option_id: string;
    text_field_id: string;
    media_field_id: string;
    post_url_field_id: string;
  } | null;
  /**
   * The rule as the setup card would create it, minus the connection and account the person has still to choose. "Open in the automation
   * editor" hands over exactly this, unsaved. Null when `fields` is.
   */
  draft: {
    name: string;
    trigger: { type: 'record_updated'; field_id: string };
    condition: { field: string; op: 'eq'; value: string };
    action: { type: 'post_social'; text: string; media_field_id: string; result_field_id: string; require_approval: true };
  } | null;
};

export type PublishingEnableResult = {
  /** False when the rule was already on with this connection and account (the call is idempotent). */
  changed: boolean;
  rule: PublishingRule;
};

export type PublishingDisableResult = {
  /** The rules this call paused (empty when none was on). */
  changed: PublishingRule[];
  rules: PublishingRule[];
};
