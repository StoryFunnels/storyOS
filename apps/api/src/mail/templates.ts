import type { EmailInput, RenderedEmail } from './email.types';

/** Minimal escaping — these templates only ever interpolate names/titles/urls,
 * never full user HTML, but a display name or record title is still untrusted
 * input once it lands in an email client. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Plain, unbranded shell (MN-103 v1). MN-147 replaces this wrapper (and the
 * per-kind render functions below) with StoryOS-branded markup — callers only
 * ever see the `EmailInput` → `RenderedEmail` contract in email.service.ts, so
 * that swap never touches invites/comments/auth call sites.
 */
function wrap(bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#111827;">${bodyHtml}</body></html>`;
}

function link(url: string, label = url): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function renderInvite(role: string, acceptUrl: string): RenderedEmail {
  const text = `You've been invited to a StoryOS workspace as ${role}. Accept: ${acceptUrl}`;
  return {
    subject: `You're invited to StoryOS`,
    text,
    html: wrap(
      `<p>You've been invited to a StoryOS workspace as <strong>${escapeHtml(role)}</strong>.</p><p>${link(acceptUrl, 'Accept the invite')}</p>`,
    ),
  };
}

function renderMention(
  actorName: string,
  recordTitle: string,
  excerpt: string,
  url: string,
): RenderedEmail {
  const text = `${excerpt}\n\nOpen: ${url}`;
  return {
    subject: `${actorName} mentioned you on "${recordTitle}"`,
    text,
    html: wrap(
      `<p>${escapeHtml(excerpt)}</p><p>${link(url, 'Open the record')}</p>`,
    ),
  };
}

function renderVerifyEmail(url: string): RenderedEmail {
  const text = `Confirm your email: ${url}`;
  return {
    subject: 'Verify your StoryOS email',
    text,
    html: wrap(`<p>Confirm your email address to finish setting up StoryOS.</p><p>${link(url, 'Verify email')}</p>`),
  };
}

function renderResetPassword(url: string): RenderedEmail {
  const text = `Reset your password: ${url}`;
  return {
    subject: 'Reset your StoryOS password',
    text,
    html: wrap(`<p>Reset your StoryOS password.</p><p>${link(url, 'Reset password')}</p>`),
  };
}

/** One small render function per email kind (MN-103) — the seam MN-147 swaps
 * branded HTML into without restructuring any call site. */
export function renderEmail(input: EmailInput): RenderedEmail {
  switch (input.kind) {
    case 'invite':
      return renderInvite(input.role, input.acceptUrl);
    case 'mention':
      return renderMention(input.actorName, input.recordTitle, input.excerpt, input.url);
    case 'verify-email':
      return renderVerifyEmail(input.url);
    case 'reset-password':
      return renderResetPassword(input.url);
  }
}
