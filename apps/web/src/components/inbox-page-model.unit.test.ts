import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INBOX_TABS, inboxSubtitle, inboxTabQuery, waitingApprovalLabel } from './inbox-page-model';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Ticket #1279 item 3 — the line under the page title. */
describe('inboxSubtitle', () => {
  it('names the unread count', () => {
    expect(inboxSubtitle(3)).toBe('3 unread');
    expect(inboxSubtitle(1)).toBe('1 unread');
  });
  it('says "caught up" only for a real zero', () => {
    expect(inboxSubtitle(0)).toBe('You’re all caught up');
  });
  it('says nothing for a count it does not have (never a confident zero)', () => {
    expect(inboxSubtitle(undefined)).toBeNull();
    expect(inboxSubtitle(Number.NaN)).toBeNull();
    expect(inboxSubtitle(-1)).toBeNull();
  });
});

describe('the page title', () => {
  const page = read('../app/w/[ws]/inbox/page.tsx');
  const heading = read('./page-heading.tsx');
  it('is the shared 22px/700 heading with the unread subtitle, not a 14px toolbar h1', () => {
    expect(heading).toContain('text-[22px] font-bold');
    expect(heading).toContain('tracking-[-0.02em]');
    expect(page).toContain('<PageHeading title="Inbox"');
    expect(page).toContain('inboxSubtitle(unreadCount.data)');
    expect(page).not.toMatch(/<h1 className="shrink-0 text-sm font-semibold/);
  });
});

/** Ticket #1279 item 4 — the tabs. */
describe('INBOX_TABS / inboxTabQuery', () => {
  it('puts Archived in the tab list, last, in the reference order', () => {
    expect(INBOX_TABS.map((t) => t.label)).toEqual(['All', 'Assigned', 'Mentions', 'Comments', 'Status', 'Approvals', 'Archived']);
  });
  it('a type tab asks for that type, unarchived', () => {
    expect(inboxTabQuery('assigned')).toEqual({ type: 'assigned', archived: false });
    expect(inboxTabQuery('all')).toEqual({ type: 'all', archived: false });
    expect(inboxTabQuery('action_approval_requested')).toEqual({ type: 'action_approval_requested', archived: false });
  });
  it('Archived asks for the archive with no type filter (every archived row, not only one type)', () => {
    expect(inboxTabQuery('archived')).toEqual({ type: 'all', archived: true });
  });
});

describe('waitingApprovalLabel', () => {
  const rows = [{ ref_id: 'a1' }, { ref_id: 'a2' }, { ref_id: 'a3' }, { ref_id: null }];
  const base = { moreRows: false, pendingCapped: false };
  it('counts the approval notifications whose approval is still pending', () => {
    expect(waitingApprovalLabel({ rows, pendingIds: new Set(['a1', 'a3']), ...base })).toBe('2');
  });
  it('does not count a decided approval, or a row with no approval id', () => {
    expect(waitingApprovalLabel({ rows, pendingIds: new Set(['a2']), ...base })).toBe('1');
  });
  it('draws nothing for zero (a gold 0 is noise)', () => {
    expect(waitingApprovalLabel({ rows, pendingIds: new Set(), ...base })).toBeNull();
  });
  it('draws nothing while either list is unknown, never a zero', () => {
    expect(waitingApprovalLabel({ rows: undefined, pendingIds: new Set(['a1']), ...base })).toBeNull();
    expect(waitingApprovalLabel({ rows, pendingIds: undefined, ...base })).toBeNull();
  });
  it('is a lower bound ("N+") when notifications are paged or the pending list is capped', () => {
    expect(waitingApprovalLabel({ rows, pendingIds: new Set(['a1']), moreRows: true, pendingCapped: false })).toBe('1+');
    expect(waitingApprovalLabel({ rows, pendingIds: new Set(['a1']), moreRows: false, pendingCapped: true })).toBe('1+');
  });
});

describe('the page wiring', () => {
  const page = read('../app/w/[ws]/inbox/page.tsx');
  it('draws the Approvals count through the shared gold badge, only on the Approvals tab', () => {
    expect(page).toContain("t.key === 'action_approval_requested' && approvalsLabel");
    expect(page).toContain('<CountBadge');
  });
  it('has no Show-archived toggle any more; Archived is one of the tabs', () => {
    expect(page).not.toContain('Show archived');
    expect(page).toContain('INBOX_TABS.map');
  });
  it('puts the email offer above the tabs', () => {
    const offer = page.indexOf('<MyWorkEmailOffer');
    const tabs = page.indexOf('role="tablist"');
    expect(offer).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(offer);
  });
  it('keeps the pieces the restructure must not lose: the type filter in the query, the archive flag, the preview pane', () => {
    expect(page).toContain("if (type !== 'all') query.type = type;");
    expect(page).toContain("if (archived) query.archived = 'true';");
    expect(page).toContain('Select a notification to preview it.');
  });
});
