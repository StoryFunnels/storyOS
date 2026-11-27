import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SlackSubscriptionDto } from '@/lib/slack-subscriptions';
import { SubscriptionRow } from './slack-subscriptions-dialog';

/** Ticket #1388 — a subscription row in every state, and who is offered the screen at all. */
const sub = (over: Partial<SlackSubscriptionDto> = {}): SlackSubscriptionDto => ({
  id: 's1',
  channel: 'general',
  events: ['created', 'commented'],
  created_by: 'u1',
  created_by_name: 'Maya Chen',
  needs_attention: null,
  sent_count: 12,
  failed_count: 0,
  last_error: null,
  last_error_at: null,
  last_sent_at: '2026-11-26T10:00:00Z',
  created_at: '2026-11-20T10:00:00Z',
  scope: { kind: 'database', id: 'db1', name: 'Issues' },
  closed: false,
  ...over,
});
const html = (s: SlackSubscriptionDto, removing = false) => renderToStaticMarkup(createElement(SubscriptionRow, { row: s, removing, onRemove: () => {} }));

describe('#1388 a subscription row', () => {
  it('names the channel, the events and who added it, with a Remove control', () => {
    const out = html(sub());
    expect(out).toContain('#general');
    expect(out).toContain('Record created, comment added');
    expect(out).toContain('added by Maya Chen');
    expect(out).toContain('Remove');
    expect(out).toContain('aria-label="Remove #general"');
    expect(html(sub({ channel: null }))).toContain('aria-label="Remove the connection’s channel"');
  });

  it('a healthy row shows its delivery counts and no attention line and no error', () => {
    const out = html(sub());
    expect(out).toContain('Sent 12');
    expect(out).toContain('Failed 0');
    expect(out).not.toContain('slack-attention');
    expect(out).not.toContain('slack-last-error');
  });

  it('a failed delivery shows its last error, as the API sent it', () => {
    const out = html(sub({ failed_count: 2, last_error: 'channel_not_found', last_error_at: '2026-11-26T11:00:00Z' }));
    expect(out).toContain('Failed 2');
    expect(out).toContain('Last error: channel_not_found');
  });

  it('a subscription that is skipped (its creator lost access) says so, loudly, naming who', () => {
    for (const code of ['creator_left', 'creator_not_admin'] as const) {
      const out = html(sub({ needs_attention: code }));
      expect(out, code).toContain('data-testid="slack-attention"');
      expect(out, code).toContain('Not posting: Maya Chen');
      expect(out, code).toContain(`data-needs-attention="${code}"`);
      expect(out, code).toContain('border-warning');
    }
  });

  it('a real zero is drawn as 0, never hidden', () => {
    const out = html(sub({ sent_count: 0, failed_count: 0 }));
    expect(out).toContain('Sent 0');
    expect(out).toContain('Failed 0');
  });

  it('with no stored channel (webhook or default) it says so instead of a blank', () => {
    expect(html(sub({ channel: null }))).toContain('The connection’s channel');
  });

  it('Remove is disabled while it is being removed', () => {
    // The attribute itself (` disabled=""`): the button's class list also contains the word, as `disabled:opacity-…`.
    expect(html(sub(), true)).toMatch(/<button[^>]* disabled=""[^>]*>Remove/);
    expect(html(sub(), false)).not.toMatch(/<button[^>]* disabled=""[^>]*>Remove/);
  });
});

describe('#1388 who is offered the screen', () => {
  const sidebar = readFileSync(fileURLToPath(new URL('./sidebar.tsx', import.meta.url)), 'utf8');
  it('a space menu offers it to a workspace admin only', () => {
    expect(sidebar).toContain("{isAdmin && <DropdownMenuItem onSelect={() => setSlacking(true)}>Slack notifications…</DropdownMenuItem>}");
  });
  it('a database menu offers it to a workspace admin only, and never on a system database', () => {
    expect(sidebar).toContain("label: 'Slack notifications…', onSelect: () => setSlacking(true), hidden: !isAdmin || Boolean(db.isSystem)");
  });
  it('the dialogs are mounted with the target, its kind and its restricted flag', () => {
    expect(sidebar).toContain('<SlackSubscriptionsDialogContent ws={ws} kind="space" id={space.id}');
    expect(sidebar).toContain('<SlackSubscriptionsDialogContent ws={ws} kind="database" id={db.id}');
    expect(sidebar).toContain('restricted={Boolean(space.restricted)}');
    expect(sidebar).toContain('restricted={Boolean(db.restricted)}');
  });
});
