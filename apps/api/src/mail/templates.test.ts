import { describe, expect, it } from 'vitest';
import { renderEmail } from './templates';

describe('renderEmail — branded HTML (MN-147)', () => {
  it('renders an invite email with a greeting, the workspace name, role, and accept button', () => {
    const email = renderEmail({
      kind: 'invite',
      to: 'new@example.com',
      role: 'member',
      acceptUrl: 'https://app.storyos.dev/invite?token=abc',
      workspaceName: 'Acme Co',
    });
    expect(email.subject).toBe("You're invited to Acme Co");
    expect(email.html).toContain('Hi there,');
    expect(email.html).toContain('Acme Co');
    expect(email.html).toContain('member');
    expect(email.html).toContain('Accept invite');
    expect(email.html).toContain('https://app.storyos.dev/invite?token=abc');
    expect(email.text).toContain('Acme Co');
    expect(email.text).toContain('member');
    expect(email.text).toContain('https://app.storyos.dev/invite?token=abc');
  });

  it('renders a mention email naming the actor and the record, with an "Open the record" button', () => {
    const email = renderEmail({
      kind: 'mention',
      to: 'target@example.com',
      actorName: 'Ada Lovelace',
      recordTitle: 'Q3 roadmap',
      excerpt: 'take a look at this',
      url: 'https://app.storyos.dev/r/rec1',
    });
    expect(email.subject).toBe('Ada Lovelace mentioned you on "Q3 roadmap"');
    expect(email.html).toContain('Ada Lovelace');
    expect(email.html).toContain('Q3 roadmap');
    expect(email.html).toContain('Open the record');
    expect(email.text).toContain('take a look at this');
    expect(email.text).toContain('https://app.storyos.dev/r/rec1');
    expect(email.html).toContain('https://app.storyos.dev/r/rec1');
  });

  it('renders the better-auth email-verification email with a "Confirm your email" button', () => {
    const email = renderEmail({
      kind: 'verify-email',
      to: 'new@example.com',
      url: 'https://app.storyos.dev/verify?token=xyz',
    });
    expect(email.subject).toBe('Confirm your email');
    expect(email.html).toContain('Hi there,');
    expect(email.html).toContain('Confirm your email');
    expect(email.html).toContain('https://app.storyos.dev/verify?token=xyz');
    expect(email.text).toContain('https://app.storyos.dev/verify?token=xyz');
  });

  it('renders the better-auth password-reset email with a "Reset your password" button', () => {
    const email = renderEmail({
      kind: 'reset-password',
      to: 'new@example.com',
      url: 'https://app.storyos.dev/reset?token=xyz',
    });
    expect(email.subject).toBe('Reset your password');
    expect(email.html).toContain('Reset your password');
    expect(email.html).toContain('https://app.storyos.dev/reset?token=xyz');
    expect(email.text).toContain('https://app.storyos.dev/reset?token=xyz');
  });

  it('populates a non-generic, sensible plain-text fallback per kind (not a stale placeholder)', () => {
    const invite = renderEmail({
      kind: 'invite',
      to: 'a@b.com',
      role: 'admin',
      acceptUrl: 'https://x/y',
      workspaceName: 'Acme Co',
    });
    const verify = renderEmail({ kind: 'verify-email', to: 'a@b.com', url: 'https://x/verify' });
    const reset = renderEmail({ kind: 'reset-password', to: 'a@b.com', url: 'https://x/reset' });

    // Each kind's text differs and reflects its own content — not one shared string.
    expect(invite.text).not.toBe(verify.text);
    expect(verify.text).not.toBe(reset.text);
    expect(invite.text).toMatch(/Acme Co/);
    expect(invite.text).toMatch(/admin/);
    expect(verify.text).toMatch(/verify|confirm/i);
    expect(reset.text).toMatch(/reset/i);
  });

  it('includes a prefers-color-scheme: dark override in the HTML', () => {
    const email = renderEmail({
      kind: 'reset-password',
      to: 'a@b.com',
      url: 'https://x/reset',
    });
    expect(email.html).toContain('@media (prefers-color-scheme: dark)');
    // The dark overrides must actually repaint the light-mode surfaces, not just
    // declare an empty block.
    expect(email.html).toMatch(/\.eo-page\s*\{\s*background:\s*#0f131b\s*!important;/);
    expect(email.html).toMatch(/\.eo-card\s*\{\s*background:\s*#171c26/);
  });

  it('escapes an untrusted workspace name before it reaches the HTML body (HTML-injection guard)', () => {
    const email = renderEmail({
      kind: 'invite',
      to: 'target@example.com',
      role: 'member',
      acceptUrl: 'https://app.storyos.dev/invite?token=abc',
      workspaceName: '<script>alert(1)</script>Acme"',
    });
    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('&quot;');
    // The plain-text fallback is not HTML, so the raw name is fine there.
    expect(email.text).toContain('<script>alert(1)</script>Acme"');
  });

  it('escapes untrusted display names/titles before they reach the HTML body', () => {
    const email = renderEmail({
      kind: 'mention',
      to: 'target@example.com',
      actorName: 'Ada',
      recordTitle: 'Q3 <script>alert(1)</script>',
      excerpt: '<img src=x onerror=alert(1)> look at this',
      url: 'https://app.storyos.dev/r/rec1',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img src=x');
  });

  it('does not escape StoryOS\'s own static copy/markup (the wordmark and CTA button render as real HTML)', () => {
    const email = renderEmail({
      kind: 'reset-password',
      to: 'a@b.com',
      url: 'https://x/reset',
    });
    expect(email.html).toContain('<a href="https://x/reset"');
    expect(email.html).toContain('StoryOS');
    expect(email.html).not.toContain('&lt;a href');
  });
});
