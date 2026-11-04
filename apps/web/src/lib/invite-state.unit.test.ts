import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inviteRowModel, inviteState, invitationsSummary, sortInvites } from './invite-state';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const date = (iso: string) => new Date(iso).toISOString().slice(0, 10);

// JCM Agency's four invitations (ticket #974): all expired on 25 Aug, roles admin + three members.
const jcm = [
  { email: 'sergey.romanyuk@jamescookmedia.com', role: 'admin', expires_at: '2026-08-25T09:00:00Z', created_at: '2026-08-05T09:00:00Z' },
  { email: 'oleksandr.kyrychenko@jamescookmedia.com', role: 'member', expires_at: '2026-08-25T09:00:00Z', created_at: '2026-08-05T09:00:00Z' },
  { email: 'mark.sarmiento@digitalpurse.ai', role: 'member', expires_at: '2026-08-25T09:00:00Z', created_at: '2026-08-05T09:00:00Z' },
  { email: 'jake.alim@storypages.ai', role: 'member', expires_at: '2026-08-25T09:00:00Z', created_at: '2026-08-05T09:00:00Z' },
];
const fresh = { email: 'new@example.com', role: 'guest', expires_at: '2026-11-10T12:00:00Z', created_at: '2026-11-03T12:00:00Z' };

describe('an invitation says whether it expired (#1186 AC2)', () => {
  it('derives the state from expires_at', () => {
    expect(inviteState({ expires_at: '2026-08-25T09:00:00Z' }, NOW)).toBe('expired');
    expect(inviteState({ expires_at: '2026-11-10T12:00:00Z' }, NOW)).toBe('pending');
  });

  it('the moment of expiry counts as expired, one second before does not', () => {
    expect(inviteState({ expires_at: new Date(NOW).toISOString() }, NOW)).toBe('expired');
    expect(inviteState({ expires_at: new Date(NOW + 1000).toISOString() }, NOW)).toBe('pending');
  });

  it('never claims "expired" on a date it cannot read', () => {
    expect(inviteState({ expires_at: 'not a date' }, NOW)).toBe('pending');
  });

  it('JCM-like data: all four read "Expired 2026-08-25" and say who and when they were invited', () => {
    const rows = jcm.map((i) => inviteRowModel(i, NOW, date));
    expect(rows.every((r) => r.state === 'expired' && r.pill === 'Expired 2026-08-25')).toBe(true);
    expect(rows[0]!.detail).toBe('Admin · invited 2026-08-05');
    expect(rows[1]!.detail).toBe('Member · invited 2026-08-05');
    expect(invitationsSummary(jcm, NOW)).toBe('4 expired · none pending');
  });

  it('an expired row offers Send again as the primary action; a pending one still offers it, quietly (nothing is taken away)', () => {
    const expired = inviteRowModel(jcm[0]!, NOW, date);
    const pending = inviteRowModel(fresh, NOW, date);
    expect(expired).toMatchObject({ resendLabel: 'Send again', resendIsPrimary: true });
    expect(pending).toMatchObject({ resendLabel: 'Send again', resendIsPrimary: false, pill: 'Pending' });
    expect(pending.detail).toBe('Guest · invited 2026-11-03 · expires 2026-11-10');
    expect(expired.resendAriaLabel).toBe('Send the invitation to sergey.romanyuk@jamescookmedia.com again');
  });

  it('counts a mix, and a workspace with no expired invitations says only what is pending', () => {
    expect(invitationsSummary([...jcm.slice(0, 1), fresh, fresh], NOW)).toBe('1 expired · 2 pending');
    expect(invitationsSummary([fresh], NOW)).toBe('1 pending');
  });

  it('lists expired invitations first and keeps the API order within each group', () => {
    const a = { ...fresh, email: 'a@x.com' };
    const b = { ...fresh, email: 'b@x.com' };
    expect(sortInvites([a, jcm[0]!, b, jcm[1]!], NOW).map((i) => i.email)).toEqual([jcm[0]!.email, jcm[1]!.email, 'a@x.com', 'b@x.com']);
  });
});

describe('the Members page draws what the model says', () => {
  const page = readFileSync(fileURLToPath(new URL('../app/w/[ws]/settings/members/page.tsx', import.meta.url)), 'utf8');

  it('renders the pill, the detail and the Send again button from the shared model, and refetches after a send', () => {
    expect(page).toContain('inviteRowModel(invite, now, date)');
    expect(page).toContain('{model.pill}');
    expect(page).toContain('{model.resendLabel}');
    expect(page).toContain("queryKey: ['invites', ws]");
  });

  it('no longer labels every invitation "Pending"', () => {
    expect(page).not.toMatch(/>\s*Pending\s*</);
  });

  it('calls the resend endpoint, which the API accepts for an expired invitation', () => {
    expect(page).toContain("'/api/v1/workspaces/{ws}/invites/{invite}/resend'");
  });
});
