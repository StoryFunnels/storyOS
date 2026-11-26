import { describe, expect, it, vi } from 'vitest';

const toastFn = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastFn }));

import { announceViewMatch, viewMatchNotice } from './view-match';

describe('ticket #1339 — viewMatchNotice is the one decision', () => {
  it('says nothing when the record matches the view', () => {
    expect(viewMatchNotice({ number: 7, view_match: { matches: true, unmet: [] } })).toBeNull();
  });

  it('names the record when it does not match', () => {
    const n = viewMatchNotice({ number: 42, view_match: { matches: false, unmet: ['due'] } });
    expect(n).toEqual({ text: 'Created #42 — not shown in this view', number: 42, unmet: ['due'] });
  });

  it('keeps a sensible line when the response carries no number', () => {
    expect(viewMatchNotice({ number: null, view_match: { matches: false, unmet: [] } })?.text).toBe(
      'Created — not shown in this view',
    );
    expect(viewMatchNotice({ view_match: { matches: false, unmet: [] } })?.number).toBeNull();
  });

  it('ABSENT view_match is "show nothing": never read as in the view and never as outside it', () => {
    expect(viewMatchNotice({ number: 3 })).toBeNull();
    expect(viewMatchNotice({ number: 3, view_match: null })).toBeNull();
  });

  it('a null or missing body says nothing', () => {
    expect(viewMatchNotice(null)).toBeNull();
    expect(viewMatchNotice(undefined)).toBeNull();
  });

  it('only an explicit false counts: a malformed verdict is not a notice', () => {
    expect(viewMatchNotice({ view_match: { unmet: ['x'] } as never })).toBeNull();
    expect(viewMatchNotice({ view_match: { matches: 'false' as never, unmet: [] } })).toBeNull();
  });

  it('tolerates a missing unmet list', () => {
    expect(viewMatchNotice({ number: 1, view_match: { matches: false } as never })?.unmet).toEqual([]);
  });
});

describe('ticket #1339 — announceViewMatch', () => {
  const where = () => ({ ws: 'w1', db: 'd1', push: vi.fn() });

  it('toasts once for a record outside the view, with an Open link to the plain record page', () => {
    toastFn.mockClear();
    const w = where();
    announceViewMatch({ id: 'r1', title: 'Fix it', number: 5, view_match: { matches: false, unmet: ['title'] } }, w);
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [text, opts] = toastFn.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(text).toBe('Created #5 — not shown in this view');
    expect(opts.action.label).toBe('Open');
    opts.action.onClick();
    expect(w.push).toHaveBeenCalledWith('/w/w1/d/d1/r/fix-it-5');
    expect(w.push.mock.calls[0]![0]).not.toContain('new=1');
  });

  it('does not toast when matched, absent, or null', () => {
    toastFn.mockClear();
    announceViewMatch({ id: 'r1', number: 1, view_match: { matches: true, unmet: [] } }, where());
    announceViewMatch({ id: 'r1', number: 1 }, where());
    announceViewMatch(null, where());
    expect(toastFn).not.toHaveBeenCalled();
  });
});
