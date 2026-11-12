import type { NotificationType } from './inbox-panel';

/**
 * Ticket #1279 — the sentence after the actor's name, one per notification type the API can emit. The test beside this
 * file derives the type list from the API source (not from this map), so a type added there without a verb here fails
 * the build instead of rendering as a bare name with no sentence (`invite_accepted` did exactly that).
 */
export const NOTIFICATION_VERBS: Record<NotificationType, string> = {
  assigned: 'assigned you',
  mentioned: 'mentioned you',
  commented: 'commented',
  state_changed: 'updated status on',
  approval_requested: 'needs your approval on',
  trial_reminder_23: 'sent a trial reminder',
  trial_reminder_29: 'sent a final trial reminder',
  connection_error: 'flagged a connection',
  auto_reload_failed: 'flagged an auto-reload failure',
  automation_disabled: 'disabled an automation',
  action_approval_requested: 'needs your approval to run',
  record_changed: 'changed',
  send_email_cap_reached: 'reached the daily email limit',
  source_run_cap_reached: 'reached a source’s monthly run limit',
  invite_accepted: 'accepted your invite',
  usage_threshold_reached: 'is nearing a usage limit',
  runner_offline: 'lost contact with a Runner',
  agent_wake_failed: 'could not finish an agent job',
  agent_budget_warning: 'is nearing an agent’s monthly budget',
  agent_budget_paused: 'paused an agent at its monthly budget',
};

/** What a row says when the API sends a type this build does not know yet: neutral words, never the raw code. */
export const UNKNOWN_NOTIFICATION_VERB = 'sent you a notification';

/** The verb for any type string. Own-property check so a type like "constructor" cannot reach Object.prototype. */
export function notificationVerb(type: string): string {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_VERBS, type)
    ? NOTIFICATION_VERBS[type as NotificationType]
    : UNKNOWN_NOTIFICATION_VERB;
}
