/**
 * Transactional email kinds (MN-103). Each variant carries exactly the data its
 * template needs — no raw subject/body at the call site — so the rendering
 * (templates.ts) is the only place that knows what an email says, and MN-147
 * (branded HTML) can swap that layer out without touching any call site below.
 */
export type EmailInput =
  | { kind: 'invite'; to: string; role: string; acceptUrl: string; workspaceName: string }
  | {
      kind: 'mention';
      to: string;
      actorName: string;
      recordTitle: string;
      excerpt: string;
      url: string;
    }
  | { kind: 'verify-email'; to: string; url: string }
  | { kind: 'reset-password'; to: string; url: string }
  | {
      /** Day-23/day-29 proactive trial-expiry heads-up (#263). */
      kind: 'trial-reminder';
      to: string;
      workspaceName: string;
      daysRemaining: number;
      billingUrl: string;
    }
  | {
      /** Auto-reload's off-session charge exhausted its retries and was
       * disabled (#265) — sent once per disablement, not per failed attempt. */
      kind: 'auto-reload-failed';
      to: string;
      workspaceName: string;
      billingUrl: string;
    };

export type EmailKind = EmailInput['kind'];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
