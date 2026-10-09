import { describe, expect, it } from 'vitest';
import { approvalView, decidedSummary, type ApprovalRow } from './approval-state';

const row = (id: string, status: string, extra: Partial<ApprovalRow> = {}): ApprovalRow => ({ id, status, ...extra });

describe('approvalView (ticket #869)', () => {
  it('offers controls only for an approval the API lists as pending', () => {
    expect(approvalView({ id: 'a', pending: [row('a', 'pending')], all: [row('a', 'pending')] })).toEqual({ kind: 'pending' });
    expect(approvalView({ id: 'a', pending: [row('a', 'pending')], all: undefined })).toEqual({ kind: 'pending' });
  });
  it('a decided approval is DECIDED, with who, when and why — in both directions', () => {
    const approved = row('a', 'approved', { decided_by: 'u1', decided_at: '2026-10-09T12:00:00Z' });
    expect(approvalView({ id: 'a', pending: [], all: [approved] })).toEqual({ kind: 'decided', status: 'approved', by: 'u1', at: '2026-10-09T12:00:00Z', reason: null });
    const rejected = row('b', 'rejected', { decided_by: 'u2', reason: 'wrong audience' });
    expect(approvalView({ id: 'b', pending: [], all: [rejected] })).toMatchObject({ kind: 'decided', status: 'rejected', reason: 'wrong audience' });
  });
  it('an expired approval is decided too', () => {
    expect(approvalView({ id: 'a', pending: [], all: [row('a', 'expired')] })).toMatchObject({ kind: 'decided', status: 'expired' });
  });
  it('waits for both lists before saying anything about an approval that is not pending', () => {
    expect(approvalView({ id: 'a', pending: undefined, all: undefined })).toEqual({ kind: 'loading' });
    expect(approvalView({ id: 'a', pending: [], all: undefined })).toEqual({ kind: 'loading' });
  });
  it('NEVER offers controls for an approval neither list knows (older than the window, or not visible)', () => {
    expect(approvalView({ id: 'gone', pending: [], all: [row('x', 'approved')] })).toMatchObject({ kind: 'decided', status: 'unknown' });
  });
});

describe('decidedSummary', () => {
  const names: Record<string, string> = { u1: 'Ievgen' };
  const date = (iso: string) => iso.slice(0, 10);
  it('names the decider and the date', () => {
    expect(decidedSummary({ kind: 'decided', status: 'approved', by: 'u1', at: '2026-10-09T12:00:00Z', reason: null }, (u) => names[u], date)).toBe('Approved by Ievgen · 2026-10-09');
  });
  it('omits the decider (rather than saying "someone") while the member list is still loading', () => {
    expect(decidedSummary({ kind: 'decided', status: 'approved', by: 'u1', at: '2026-10-09T12:00:00Z', reason: null }, () => undefined, date, false)).toBe('Approved · 2026-10-09');
  });
  it('carries a rejection reason, and falls back to "someone" for an unknown decider', () => {
    expect(decidedSummary({ kind: 'decided', status: 'rejected', by: 'zz', at: null, reason: 'not now' }, (u) => names[u], date)).toBe('Rejected by someone — not now');
  });
  it('says plainly when it expired or is simply no longer waiting', () => {
    expect(decidedSummary({ kind: 'decided', status: 'expired', by: null, at: null, reason: null }, () => undefined, date)).toBe('Expired without a decision');
    expect(decidedSummary({ kind: 'decided', status: 'unknown', by: null, at: null, reason: null }, () => undefined, date)).toMatch(/no longer waiting/);
  });
});
