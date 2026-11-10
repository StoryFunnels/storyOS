import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmailKind } from './email.types';
import { renderEmail, renderBrandedEmail } from './templates';
import { parseMailFrom } from './mail-from';
import { QUILL_LINE, quillAvatarPath } from './quill-header';
import { renderDigest } from '../my-work-digest/digest-render';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function assertHeader(html: string) {
  expect(html).toContain(`>${QUILL_LINE}<`);
  expect(html).toMatch(/<img[^>]*alt="Quill"[^>]*class="d-quill-light"/);
  expect(html).toMatch(/<img[^>]*alt="Quill"[^>]*class="d-quill-dark"/);
  expect(html).toContain(quillAvatarPath('light', 96));
  expect(html).toContain(quillAvatarPath('dark', 192));
  expect(html).toContain('@media (prefers-color-scheme: dark)');
  expect(html).toContain('.d-quill-dark{display:inline-block!important}');
  expect(html).toContain('.d-quill-line{color:#f3efe7!important}');
}

const digest = () =>
  renderDigest({
    workspaceName: 'Acme',
    dateLabel: 'Tue 10 Nov',
    sections: [{ key: 'waiting', total: 1, rows: [{ title: 'T', url: 'https://app.test/r/1', meta: 'm' }] }],
    recipientEmail: 'a@b.c',
    cadenceText: 'every weekday',
    webUrl: 'https://app.test',
    myWorkUrl: 'https://app.test/me',
    customizeUrl: 'https://app.test/s',
    stopUrl: 'https://api.test/u',
  })!;

/** One sample per kind. A new kind with no sample FAILS the enumeration test below. */
const SAMPLES: Record<EmailKind, () => { html: string }> = {
  'my-work-digest': () => {
    const d = digest();
    return renderEmail({ kind: 'my-work-digest', to: 'a@b.c', subject: d.subject, html: d.html, text: d.text, unsubscribeUrl: 'https://api.test/u' });
  },
  invite: () => renderEmail({ kind: 'invite', to: 'a@b.c', role: 'member', acceptUrl: 'https://x/i', workspaceName: 'Acme' }),
  mention: () => renderEmail({ kind: 'mention', to: 'a@b.c', actorName: 'Ada', recordTitle: 'R', excerpt: 'e', url: 'https://x/r' }),
  'record-changed': () => renderEmail({ kind: 'record-changed', to: 'a@b.c', actorName: 'Ada', recordTitle: 'R', summary: 's', url: 'https://x/r' }),
  'verify-email': () => renderEmail({ kind: 'verify-email', to: 'a@b.c', url: 'https://x/v' }),
  'reset-password': () => renderEmail({ kind: 'reset-password', to: 'a@b.c', url: 'https://x/p' }),
  'trial-reminder': () => renderEmail({ kind: 'trial-reminder', to: 'a@b.c', workspaceName: 'Acme', daysRemaining: 3, billingUrl: 'https://x/b' }),
  'auto-reload-failed': () => renderEmail({ kind: 'auto-reload-failed', to: 'a@b.c', workspaceName: 'Acme', billingUrl: 'https://x/b' }),
  'invite-accepted': () => renderEmail({ kind: 'invite-accepted', to: 'a@b.c', workspaceName: 'Acme', memberEmail: 'm@b.c', role: 'member', membersUrl: 'https://x/m' }),
  'onboarding-nudge': () => renderEmail({ kind: 'onboarding-nudge', to: 'a@b.c', milestone: 'guest_invited', ctaUrl: 'https://x/c' }),
  'usage-threshold': () => renderEmail({ kind: 'usage-threshold', to: 'a@b.c', workspaceName: 'Acme', metricLabel: 'records', percentUsed: 80, billingUrl: 'https://x/b' }),
  'sales-signal': () => renderEmail({ kind: 'sales-signal', to: 'a@b.c', workspaceName: 'Acme', reason: 'pro_five_seats', billingUrl: 'https://x/b' }),
};

describe('Quill header card (ticket #1266)', () => {
  // The kinds come from the source of the union itself, not a hand-copied list.
  const kinds = [...readFileSync(join(__dirname, 'email.types.ts'), 'utf8').matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1] as EmailKind);

  it('finds the email kinds in the code', () => {
    expect(kinds.length).toBeGreaterThanOrEqual(12);
  });

  it.each(kinds)('%s renders the header', (kind) => {
    const sample = SAMPLES[kind];
    expect(sample, `no sample for email kind "${kind}": add one to SAMPLES`).toBeTypeOf('function');
    assertHeader(sample().html);
  });

  it('the automation send-email shell (renderBrandedEmail) renders the header', () => {
    assertHeader(renderBrandedEmail({ heading: 'Hi', bodyHtml: '<p>x</p>' }));
  });

  it('every source file that renders a whole HTML document uses the shared header', () => {
    // Not emails: the public API docs page and the document-to-PDF/HTML export render HTML documents too.
    const NOT_EMAILS = new Set(['docs/docs.controller.ts', 'documents/export/blocks-to-html.ts']);
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => /<!doctype html>/i.test(readFileSync(f, 'utf8')))
      .filter((f) => !readFileSync(f, 'utf8').includes('quillHeaderHtml'))
      .map((f) => relative(SRC, f))
      .filter((f) => !NOT_EMAILS.has(f));
    expect(offenders).toEqual([]);
  });

  it('the avatar PNGs the header points at exist in the web app', () => {
    for (const t of ['light', 'dark'] as const)
      for (const px of [96, 192] as const) {
        expect(statSync(join(SRC, '../../web/public', quillAvatarPath(t, px))).size).toBeGreaterThan(1000);
      }
  });
});

describe('parseMailFrom (ticket #1266)', () => {
  it('parses the production sender', () => {
    expect(parseMailFrom('Quill from StoryOS <quill@storyos.dev>')).toEqual({ name: 'Quill from StoryOS', address: 'quill@storyos.dev' });
  });
  it('parses quoted names and bare addresses', () => {
    expect(parseMailFrom('"Quill from StoryOS" <q@x.io>')).toEqual({ name: 'Quill from StoryOS', address: 'q@x.io' });
    expect(parseMailFrom('q@x.io')).toEqual({ name: '', address: 'q@x.io' });
  });
  it('returns null rather than guessing', () => {
    expect(parseMailFrom('')).toBeNull();
    expect(parseMailFrom('Quill <not-an-address>')).toBeNull();
    expect(parseMailFrom('quill＠storyos.dev')).toBeNull(); // full-width at-sign
  });
});
