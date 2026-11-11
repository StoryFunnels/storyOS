import { renderBrandedEmail, renderEmail } from './templates';
import { renderDigest } from '../my-work-digest/digest-render';
import type { EmailKind } from './email.types';

/**
 * One realistic, hostile fixture per email kind (ticket #1267). "Hostile" on
 * purpose: a long unbroken URL, a long unbroken record title and a long
 * unbroken name, because the layout bugs that make a phone scroll sideways come
 * from content that cannot wrap, not from the happy path.
 */
export const LONG_URL =
  'https://app.storyos.dev/w/3448c14b-70f3-41bc-9188-839029be9f7e/d/3f743dcd-d5ca-47c0-a676-72f40934119b/r/branded-emails-overflow-sideways-on-phones?token=' +
  'a1b2c3d4e5f6'.repeat(8);
export const LONG_TITLE = 'Supercalifragilisticexpialidocious_quarterly_roadmap_reconciliation_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789';
export const LONG_NAME = 'Maximilian-Bartholomew-Featherstonehaugh-Cholmondeley-Wolfeschlegelsteinhausenbergerdorff';
export const LONG_EMAIL = 'extraordinarily.long.address.that.never.breaks@subdomain.very-long-company-name-example.co.uk';

const digest = () =>
  renderDigest({
    workspaceName: LONG_NAME,
    dateLabel: 'Tue 10 Nov',
    sections: [{ key: 'waiting', total: 1, rows: [{ title: LONG_TITLE, url: LONG_URL, meta: LONG_NAME }] }],
    recipientEmail: LONG_EMAIL,
    cadenceText: 'every weekday',
    webUrl: 'https://app.storyos.dev',
    myWorkUrl: LONG_URL,
    customizeUrl: LONG_URL,
    stopUrl: LONG_URL,
  })!;

/** One entry per EmailKind; the type makes a new kind without a fixture a compile error. */
export const EMAIL_FIXTURES: Record<EmailKind, () => { html: string }> = {
  'my-work-digest': () => {
    const d = digest();
    return renderEmail({ kind: 'my-work-digest', to: LONG_EMAIL, subject: d.subject, html: d.html, text: d.text, unsubscribeUrl: LONG_URL });
  },
  invite: () => renderEmail({ kind: 'invite', to: LONG_EMAIL, role: 'member', acceptUrl: LONG_URL, workspaceName: LONG_NAME }),
  mention: () => renderEmail({ kind: 'mention', to: LONG_EMAIL, actorName: LONG_NAME, recordTitle: LONG_TITLE, excerpt: LONG_URL, url: LONG_URL }),
  'record-changed': () =>
    renderEmail({ kind: 'record-changed', to: LONG_EMAIL, actorName: LONG_NAME, recordTitle: LONG_TITLE, summary: 'Status: ' + LONG_TITLE + ' → Done', url: LONG_URL }),
  'verify-email': () => renderEmail({ kind: 'verify-email', to: LONG_EMAIL, url: LONG_URL }),
  'reset-password': () => renderEmail({ kind: 'reset-password', to: LONG_EMAIL, url: LONG_URL }),
  'trial-reminder': () => renderEmail({ kind: 'trial-reminder', to: LONG_EMAIL, workspaceName: LONG_NAME, daysRemaining: 3, billingUrl: LONG_URL }),
  'auto-reload-failed': () => renderEmail({ kind: 'auto-reload-failed', to: LONG_EMAIL, workspaceName: LONG_NAME, billingUrl: LONG_URL }),
  'invite-accepted': () =>
    renderEmail({ kind: 'invite-accepted', to: LONG_EMAIL, workspaceName: LONG_NAME, memberEmail: LONG_EMAIL, role: 'member', membersUrl: LONG_URL }),
  'onboarding-nudge': () => renderEmail({ kind: 'onboarding-nudge', to: LONG_EMAIL, milestone: 'guest_invited', ctaUrl: LONG_URL }),
  'usage-threshold': () =>
    renderEmail({ kind: 'usage-threshold', to: LONG_EMAIL, workspaceName: LONG_NAME, metricLabel: 'records', percentUsed: 80, billingUrl: LONG_URL }),
  'sales-signal': () => renderEmail({ kind: 'sales-signal', to: LONG_EMAIL, workspaceName: LONG_NAME, reason: 'pro_five_seats', billingUrl: LONG_URL }),
};

/** The automation send-email action's shell, with a long unbroken body and CTA. */
export const AUTOMATION_FIXTURE = () => ({
  html: renderBrandedEmail({ heading: LONG_TITLE, bodyHtml: `<p>${LONG_URL}</p><p>${LONG_NAME}</p>`, cta: { label: 'Open ' + LONG_TITLE, url: LONG_URL } }),
});
