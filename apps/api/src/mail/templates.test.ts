import { describe, expect, it } from 'vitest';
import { renderEmail } from './templates';

describe('renderEmail (MN-103)', () => {
  it('renders an invite email with the accept link and role', () => {
    const email = renderEmail({
      kind: 'invite',
      to: 'new@example.com',
      role: 'member',
      acceptUrl: 'https://app.storyos.dev/invite?token=abc',
    });
    expect(email.subject).toMatch(/invited to StoryOS/i);
    expect(email.text).toContain('member');
    expect(email.text).toContain('https://app.storyos.dev/invite?token=abc');
    expect(email.html).toContain('https://app.storyos.dev/invite?token=abc');
  });

  it('renders a mention email naming the actor and the record', () => {
    const email = renderEmail({
      kind: 'mention',
      to: 'target@example.com',
      actorName: 'Ada Lovelace',
      recordTitle: 'Q3 roadmap',
      excerpt: 'take a look at this',
      url: 'https://app.storyos.dev/r/rec1',
    });
    expect(email.subject).toBe('Ada Lovelace mentioned you on "Q3 roadmap"');
    expect(email.text).toContain('take a look at this');
    expect(email.text).toContain('https://app.storyos.dev/r/rec1');
    expect(email.html).toContain('https://app.storyos.dev/r/rec1');
  });

  it('renders the better-auth email-verification email', () => {
    const email = renderEmail({
      kind: 'verify-email',
      to: 'new@example.com',
      url: 'https://app.storyos.dev/verify?token=xyz',
    });
    expect(email.subject).toMatch(/verify your storyos email/i);
    expect(email.text).toContain('https://app.storyos.dev/verify?token=xyz');
  });

  it('renders the better-auth password-reset email', () => {
    const email = renderEmail({
      kind: 'reset-password',
      to: 'new@example.com',
      url: 'https://app.storyos.dev/reset?token=xyz',
    });
    expect(email.subject).toMatch(/reset your storyos password/i);
    expect(email.text).toContain('https://app.storyos.dev/reset?token=xyz');
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
});
