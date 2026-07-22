import { env } from '../config/env';
import type { EmailInput, RenderedEmail } from './email.types';

/**
 * Brand tokens (docs/design/design-system.md) mirrored here as literal hex —
 * email HTML can't read CSS custom properties, so these are a deliberate,
 * commented copy of apps/web/src/app/globals.css's `:root` / `:root[data-theme='dark']`
 * values, not a rediscovery of the palette. Keep the two in sync if the design
 * system's tokens change.
 */
const LIGHT = {
  pageBg: '#faf7f1', // --bg-app (cream)
  cardBg: '#ffffff', // --bg-card
  border: '#e8e5df', // --border-default
  textPrimary: '#0f1729', // --text-primary (navy)
  textSecondary: '#3d3a30', // --text-secondary
  textMuted: '#6b6658', // --text-muted
  ctaBg: '#0f1729', // --primary (navy) — same pairing button.tsx's `primary` variant uses
  ctaText: '#faf7f1', // --text-on-dark (cream)
} as const;

const DARK = {
  pageBg: '#0f131b', // --bg-app dark (navy)
  cardBg: '#171c26', // --bg-card dark
  border: '#262d39', // --border-default dark
  textPrimary: '#f3efe7', // --text-primary dark (cream)
  textSecondary: '#d0cabc', // --text-secondary dark
  textMuted: '#9a9488', // --text-muted dark
  ctaBg: '#35427a', // --primary dark
  ctaText: '#faf7f1', // --text-on-dark (unchanged across themes)
} as const;

/** Escapes caller-supplied strings (display names, workspace names, record
 * titles, comment excerpts) before they're interpolated into `bodyHtml` or a
 * heading. Never apply this to our own static copy/markup below — it isn't
 * user input, and escaping it would just show the entities to the recipient. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface BrandedEmailOptions {
  /** Main heading shown at the top of the card. Caller must pre-escape any
   * interpolated untrusted value. */
  heading: string;
  /** Inner HTML body (one or more <p> blocks). Caller must pre-escape any
   * interpolated untrusted value; static copy/markup is fine as-is. */
  bodyHtml: string;
  /** Optional call-to-action button. `url` is not escaped (it's ours or a
   * server-issued token link, never free-form user text) but IS attribute-safe
   * since it never contains quotes in practice; label is caller-controlled copy. */
  cta?: { label: string; url: string };
  /** Hidden preview text shown in the inbox list (defaults to `heading`). It's
   * embedded straight into the HTML `<body>`, not a mail header — caller must
   * pre-escape any interpolated untrusted value here too, same as heading/bodyHtml.
   * (Don't default this to a caller's plain-text `subject` string built from raw,
   * unescaped values — build it from the already-escaped pieces instead.) */
  preheader?: string;
}

/**
 * Renders StoryOS's branded HTML email shell (MN-147): table-based,
 * inline-styled light theme as the default/fallback (renders consistently in
 * Gmail, Outlook, and Apple Mail, none of which can be relied on to load an
 * external stylesheet), plus a `<style>` block with a
 * `prefers-color-scheme: dark` override for clients that honor it (Apple
 * Mail, iOS Mail, Gmail's app dark mode). Wordmark header ("Story" in navy/
 * cream, "OS" in gold — matching apps/web/public/brand/logo.svg's own text
 * treatment) rendered as an `<img>` logo (MN-284), optional CTA button, muted
 * footer, hidden preheader text.
 *
 * The `<img>` points at PNG rasters exported from the SVG brand assets
 * (apps/web/public/brand/logo.png / logo-dark.png, `@2x` variants for
 * retina) — inline SVG in `<img>` doesn't render reliably across email
 * clients (notably Outlook desktop), so a raster fallback is required. The
 * PNGs are served as static files from apps/web's `public/` dir at `WEB_URL`,
 * the same way apps/web/src/app/(auth)/auth-card.tsx references
 * `/brand/mark.svg` as a plain path. Two `<img>` tags (light/dark) are
 * swapped with the same `!important` display toggle the dark-mode CSS below
 * already uses for text — image-blocking clients fall back to the `alt`
 * text, styled inline to still resemble the wordmark.
 */
function renderBrandedEmail(opts: BrandedEmailOptions): string {
  const webUrl = env().WEB_URL.replace(/\/$/, '');
  const preheader = opts.preheader ?? opts.heading;
  const year = new Date().getFullYear();
  const font = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

  const ctaBlock = opts.cta
    ? `
      <tr>
        <td style="padding: 8px 0 4px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td class="eo-cta-bg" style="border-radius: 8px; background: ${LIGHT.ctaBg};">
                <a href="${opts.cta.url}" class="eo-cta-text"
                   style="display: inline-block; padding: 12px 22px; font-family: ${font}; font-size: 15px; font-weight: 600; color: ${LIGHT.ctaText}; text-decoration: none; border-radius: 8px;">
                  ${opts.cta.label}
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  @media (prefers-color-scheme: dark) {
    .eo-page { background: ${DARK.pageBg} !important; }
    .eo-card { background: ${DARK.cardBg} !important; border-color: ${DARK.border} !important; }
    .eo-heading { color: ${DARK.textPrimary} !important; }
    .eo-body, .eo-body p, .eo-body strong { color: ${DARK.textSecondary} !important; }
    .eo-muted { color: ${DARK.textMuted} !important; }
    .eo-footer { color: ${DARK.textMuted} !important; }
    .eo-cta-bg { background: ${DARK.ctaBg} !important; }
    .eo-cta-text { color: ${DARK.ctaText} !important; }
    .eo-logo-light { display: none !important; }
    .eo-logo-dark { display: inline-block !important; }
  }
</style>
</head>
<body class="eo-page" style="margin: 0; padding: 0; background: ${LIGHT.pageBg};">
  <span style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="eo-page" style="background: ${LIGHT.pageBg};">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width: 480px; max-width: 100%;">
          <tr>
            <td align="center" style="padding: 8px 0 20px;">
              <a href="${webUrl}" style="text-decoration: none;">
                <img src="${webUrl}/brand/logo.png" srcset="${webUrl}/brand/logo.png 1x, ${webUrl}/brand/logo@2x.png 2x" width="116" height="32" alt="StoryOS" class="eo-logo-light" style="display: inline-block; border: 0; outline: none; text-decoration: none; font-family: ${font}; font-size: 22px; font-weight: 700; color: ${LIGHT.textPrimary};">
                <img src="${webUrl}/brand/logo-dark.png" srcset="${webUrl}/brand/logo-dark.png 1x, ${webUrl}/brand/logo-dark@2x.png 2x" width="116" height="32" alt="StoryOS" class="eo-logo-dark" style="display: none; border: 0; outline: none; text-decoration: none; font-family: ${font}; font-size: 22px; font-weight: 700; color: ${DARK.textPrimary};">
              </a>
            </td>
          </tr>
          <tr>
            <td class="eo-card" style="background: ${LIGHT.cardBg}; border: 1px solid ${LIGHT.border}; border-radius: 12px; padding: 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="eo-heading" style="font-family: ${font}; font-size: 20px; font-weight: 700; color: ${LIGHT.textPrimary}; padding-bottom: 12px;">
                    ${opts.heading}
                  </td>
                </tr>
                <tr>
                  <td class="eo-body" style="font-family: ${font}; font-size: 15px; line-height: 1.6; color: ${LIGHT.textSecondary};">
                    ${opts.bodyHtml}
                  </td>
                </tr>
                ${ctaBlock}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" class="eo-footer" style="padding: 20px 8px; font-family: ${font}; font-size: 12px; line-height: 1.5; color: ${LIGHT.textMuted};">
              © ${year} StoryOS · <a href="${webUrl}" style="color: ${LIGHT.textMuted};">${webUrl.replace(/^https?:\/\//, '')}</a><br>
              You're receiving this because of activity on your StoryOS account.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderInvite(role: string, acceptUrl: string, workspaceName: string): RenderedEmail {
  const safeWorkspace = escapeHtml(workspaceName);
  const safeRole = escapeHtml(role);
  const subject = `You're invited to ${workspaceName}`;
  const text = [
    `You've been invited to join ${workspaceName} as ${role}.`,
    '',
    `Accept your invite: ${acceptUrl}`,
    '',
    'This invite link expires in 7 days.',
  ].join('\n');
  const html = renderBrandedEmail({
    heading: `You're invited to ${safeWorkspace}`,
    // Escaped, like heading/bodyHtml: the preheader is hidden HTML too, not plain text.
    preheader: `You've been invited to join ${safeWorkspace} as ${safeRole}.`,
    bodyHtml: `
      <p style="margin: 0 0 12px;">Hi there,</p>
      <p style="margin: 0 0 12px;">You've been invited to join <strong>${safeWorkspace}</strong> as a <strong>${safeRole}</strong>.</p>
      <p class="eo-muted" style="margin: 0; color: ${LIGHT.textMuted}; font-size: 13px;">This invite link expires in 7 days.</p>
    `,
    cta: { label: 'Accept invite', url: acceptUrl },
  });
  return { subject, text, html };
}

function renderMention(
  actorName: string,
  recordTitle: string,
  excerpt: string,
  url: string,
): RenderedEmail {
  const safeActor = escapeHtml(actorName);
  const safeTitle = escapeHtml(recordTitle);
  const safeExcerpt = escapeHtml(excerpt);
  const subject = `${actorName} mentioned you on "${recordTitle}"`;
  const text = [`${actorName} mentioned you on "${recordTitle}":`, '', `"${excerpt}"`, '', `Open: ${url}`].join('\n');
  const html = renderBrandedEmail({
    heading: `${safeActor} mentioned you`,
    // Escaped — the plain-text `subject` above is for the mail header, not HTML.
    preheader: `${safeActor} mentioned you on "${safeTitle}"`,
    bodyHtml: `
      <p style="margin: 0 0 12px;">Hi there,</p>
      <p style="margin: 0 0 12px;"><strong>${safeActor}</strong> mentioned you on "<strong>${safeTitle}</strong>":</p>
      <p class="eo-muted" style="margin: 0 0 12px; padding: 12px; background: ${LIGHT.pageBg}; border-radius: 8px; color: ${LIGHT.textMuted};">${safeExcerpt}</p>
    `,
    cta: { label: 'Open the record', url },
  });
  return { subject, text, html };
}

function renderVerifyEmail(url: string): RenderedEmail {
  const subject = 'Confirm your email';
  const text = [
    'Confirm your email address to finish setting up your StoryOS account.',
    '',
    `Confirm your email: ${url}`,
  ].join('\n');
  const html = renderBrandedEmail({
    heading: 'Confirm your email',
    preheader: 'Confirm your email address to finish setting up your StoryOS account.',
    bodyHtml: `
      <p style="margin: 0 0 12px;">Hi there,</p>
      <p style="margin: 0;">Confirm your email address to finish setting up your StoryOS account.</p>
    `,
    cta: { label: 'Confirm your email', url },
  });
  return { subject, text, html };
}

function renderResetPassword(url: string): RenderedEmail {
  const subject = 'Reset your password';
  const text = [
    "We received a request to reset your StoryOS password. If this wasn't you, you can safely ignore this email.",
    '',
    `Reset your password: ${url}`,
  ].join('\n');
  const html = renderBrandedEmail({
    heading: 'Reset your password',
    preheader: 'Reset your StoryOS password.',
    bodyHtml: `
      <p style="margin: 0 0 12px;">Hi there,</p>
      <p style="margin: 0;">We received a request to reset your StoryOS password. If this wasn't you, you can safely ignore this email.</p>
    `,
    cta: { label: 'Reset your password', url },
  });
  return { subject, text, html };
}

function renderTrialReminder(workspaceName: string, daysRemaining: number, billingUrl: string): RenderedEmail {
  const safeWorkspace = escapeHtml(workspaceName);
  const dayWord = daysRemaining === 1 ? 'day' : 'days';
  const subject =
    daysRemaining === 1
      ? `Your ${workspaceName} trial ends tomorrow`
      : `Your ${workspaceName} trial ends in ${daysRemaining} days`;
  const text = [
    `Your StoryOS Pro trial for ${workspaceName} ends in ${daysRemaining} ${dayWord}.`,
    '',
    `Review your plan: ${billingUrl}`,
    '',
    "If you don't add a plan before then, the workspace moves to Free automatically — no action needed if that's fine with you.",
  ].join('\n');
  const html = renderBrandedEmail({
    heading: daysRemaining === 1 ? 'Your trial ends tomorrow' : `Your trial ends in ${daysRemaining} days`,
    preheader: `Your StoryOS Pro trial for ${safeWorkspace} ends in ${daysRemaining} ${dayWord}.`,
    bodyHtml: `
      <p style="margin: 0 0 12px;">Hi there,</p>
      <p style="margin: 0 0 12px;">Your StoryOS Pro trial for <strong>${safeWorkspace}</strong> ends in <strong>${daysRemaining} ${dayWord}</strong>.</p>
      <p class="eo-muted" style="margin: 0; color: ${LIGHT.textMuted}; font-size: 13px;">If you don't add a plan before then, the workspace moves to Free automatically — no action needed if that's fine with you.</p>
    `,
    cta: { label: 'Review your plan', url: billingUrl },
  });
  return { subject, text, html };
}

function renderAutoReloadFailed(workspaceName: string, billingUrl: string): RenderedEmail {
  const safeWorkspace = escapeHtml(workspaceName);
  const subject = `Auto-reload turned off for ${workspaceName}`;
  const text = [
    `StoryOS AI credit auto-reload for ${workspaceName} failed too many times in a row and has been turned off.`,
    '',
    "This usually means the saved card was declined or needs updating (some banks require you to re-authorize off-session charges).",
    '',
    `Update your payment method: ${billingUrl}`,
    '',
    'Runs will pause once the current balance reaches zero until you top up or re-enable auto-reload.',
  ].join('\n');
  const html = renderBrandedEmail({
    heading: 'Auto-reload turned off',
    preheader: `Auto-reload for ${safeWorkspace} failed too many times and has been turned off.`,
    bodyHtml: `
      <p style="margin: 0 0 12px;">Hi there,</p>
      <p style="margin: 0 0 12px;">StoryOS AI credit auto-reload for <strong>${safeWorkspace}</strong> failed too many times in a row, so we've turned it off rather than keep retrying.</p>
      <p class="eo-muted" style="margin: 0 0 12px; color: ${LIGHT.textMuted}; font-size: 13px;">This usually means the saved card was declined or needs re-authorizing for off-session charges.</p>
      <p class="eo-muted" style="margin: 0; color: ${LIGHT.textMuted}; font-size: 13px;">Runs will pause once the current balance reaches zero until you top up or re-enable auto-reload.</p>
    `,
    cta: { label: 'Update payment method', url: billingUrl },
  });
  return { subject, text, html };
}

/** One small render function per email kind (MN-103), each producing StoryOS's
 * branded HTML shell (MN-147) — the seam callers (invites/comments/auth) never
 * have to touch when the template changes. */
export function renderEmail(input: EmailInput): RenderedEmail {
  switch (input.kind) {
    case 'invite':
      return renderInvite(input.role, input.acceptUrl, input.workspaceName);
    case 'mention':
      return renderMention(input.actorName, input.recordTitle, input.excerpt, input.url);
    case 'verify-email':
      return renderVerifyEmail(input.url);
    case 'reset-password':
      return renderResetPassword(input.url);
    case 'trial-reminder':
      return renderTrialReminder(input.workspaceName, input.daysRemaining, input.billingUrl);
    case 'auto-reload-failed':
      return renderAutoReloadFailed(input.workspaceName, input.billingUrl);
  }
}
