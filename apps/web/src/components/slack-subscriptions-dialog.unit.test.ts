import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SlackSubscriptionDto } from '@/lib/slack-subscriptions';
import { Dialog } from '@/components/ui/dialog';
import { OpenSlackSettingsLink, SlackDialogFooter, SubscriptionRow } from './slack-subscriptions-dialog';
import { DialogClose } from '@/components/ui/dialog';

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

describe('#1388 the footer matches the sibling dialogs', () => {
  // DialogClose is a Radix part and needs its Dialog around it; the footer itself renders outside the portalled content.
  const footer = (canAdd: boolean) => renderToStaticMarkup(createElement(Dialog, { open: true }, createElement(SlackDialogFooter, { canAdd })));

  it('is right-aligned, with the secondary Close first and the primary Add channel last', () => {
    const out = footer(true);
    expect(out).toContain('ml-auto flex gap-2');
    expect(out.indexOf('>Close<')).toBeGreaterThan(-1);
    expect(out.indexOf('>Close<')).toBeLessThan(out.indexOf('>Add channel<'));
  });

  it('Add channel is the submit button and is disabled until the form is valid; Close never submits', () => {
    expect(footer(true)).toMatch(/<button[^>]*type="submit"[^>]*>Add channel/);
    expect(footer(false)).toMatch(/<button[^>]* disabled=""[^>]*>Add channel/);
    expect(footer(true)).not.toMatch(/<button[^>]* disabled=""[^>]*>Add channel/);
    expect(footer(true)).toMatch(/<button[^>]*type="button"[^>]*>Close/);
  });

  it('uses the same footer shape as the Description dialog (read from its source)', () => {
    const sibling = readFileSync(fileURLToPath(new URL('./description-dialog.tsx', import.meta.url)), 'utf8');
    expect(sibling).toContain('className="ml-auto flex gap-2"');
    expect(footer(true)).toContain('class="ml-auto flex gap-2"');
  });
});

describe('#1388 a delivery that has not happened yet says what it is waiting for', () => {
  it('only a row with nothing counted and nothing wrong', () => {
    expect(html(sub({ sent_count: 0, failed_count: 0 }))).toContain('Waiting for the first record, status change or comment');
    expect(html(sub({ sent_count: 3, failed_count: 0 }))).not.toContain('Waiting for');
    expect(html(sub({ sent_count: 0, failed_count: 1, last_error: 'x' }))).not.toContain('Waiting for');
    expect(html(sub({ sent_count: 0, failed_count: 0, needs_attention: 'creator_left' }))).not.toContain('Waiting for');
  });
});

describe('#1388 the open dialog keeps itself fresh', () => {
  it('re-reads the list every few seconds while it is open (the hook is only used by the dialog)', () => {
    const q = readFileSync(fileURLToPath(new URL('../lib/slack-subscriptions-queries.ts', import.meta.url)), 'utf8');
    expect(q).toContain('refetchInterval: 5_000');
  });
});

describe('#1388 "Open Slack settings" leaves the dialog as it navigates', () => {
  // The component is a function of its props, so its element tree can be read without a DOM: the link is the child of the dialog's own
  // close control, which is what makes a click both navigate and close.
  const tree = OpenSlackSettingsLink({ ws: 'w1' }) as unknown as { type: unknown; props: { asChild?: boolean; children: { props: { href: string; children: string } } } };

  it('is wrapped in the dialog\'s close control, passing its click through to the link', () => {
    expect(tree.type).toBe(DialogClose);
    expect(tree.props.asChild).toBe(true);
  });

  it('still points at the workspace\'s Slack settings', () => {
    expect(tree.props.children.props.href).toBe('/w/w1/settings/integrations/slack');
    expect(tree.props.children.props.children).toBe('Open Slack settings');
  });

  it('renders as a link inside a dialog', () => {
    const out = renderToStaticMarkup(createElement(Dialog, { open: true }, createElement(OpenSlackSettingsLink, { ws: 'w1' })));
    expect(out).toContain('href="/w/w1/settings/integrations/slack"');
    expect(out).toContain('Open Slack settings');
  });
});
