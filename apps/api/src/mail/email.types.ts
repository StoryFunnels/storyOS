/**
 * Transactional email kinds (MN-103). Each variant carries exactly the data its
 * template needs — no raw subject/body at the call site — so the rendering
 * (templates.ts) is the only place that knows what an email says, and MN-147
 * (branded HTML) can swap that layer out without touching any call site below.
 */
export type EmailInput =
  | { kind: 'invite'; to: string; role: string; acceptUrl: string }
  | {
      kind: 'mention';
      to: string;
      actorName: string;
      recordTitle: string;
      excerpt: string;
      url: string;
    }
  | { kind: 'verify-email'; to: string; url: string }
  | { kind: 'reset-password'; to: string; url: string };

export type EmailKind = EmailInput['kind'];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
