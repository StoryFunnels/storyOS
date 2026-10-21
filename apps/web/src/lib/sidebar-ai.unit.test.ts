import { describe, expect, it } from 'vitest';
import { APPROVALS_LIST_LIMIT, goldCountLabel } from './sidebar-ai';

describe('goldCountLabel (#967)', () => {
  it('shows nothing for zero, negative or NaN: a gold 0 is noise, and a made-up number is worse', () => {
    expect(goldCountLabel(0)).toBeNull();
    expect(goldCountLabel(-1)).toBeNull();
    expect(goldCountLabel(Number.NaN)).toBeNull();
  });
  it('prints the real number below any cap', () => {
    expect(goldCountLabel(3)).toBe('3');
    expect(goldCountLabel(99, APPROVALS_LIST_LIMIT)).toBe('99');
  });
  it('says "at least" when a capped list reaches its cap, never the cap bare', () => {
    expect(goldCountLabel(APPROVALS_LIST_LIMIT, APPROVALS_LIST_LIMIT)).toBe('100+');
    expect(goldCountLabel(250, APPROVALS_LIST_LIMIT)).toBe('100+');
  });
  it('an uncapped count has no plus', () => {
    expect(goldCountLabel(1000)).toBe('1000');
  });
});

import { isAiConnected, shouldAnnounceMove, showConnectAiRow } from './sidebar-ai';

describe('#967 Connect your AI row', () => {
  it('connected = ai_connected OR mcp_oauth_connected (Otto\'s final definition): any connected AI counts', () => {
    expect(isAiConnected({ ai_connected: true })).toBe(true);
    expect(isAiConnected({ mcp_oauth_connected: true })).toBe(true);
    expect(isAiConnected({ ai_connected: false, mcp_oauth_connected: false })).toBe(false);
  });

  it('a key an older server omits reads as false, and no answer reads as not connected-yet-known', () => {
    expect(isAiConnected({})).toBe(false);
    expect(isAiConnected(undefined)).toBe(false);
  });

  it('shows only on a real "not connected"; loading and errors show nothing (no flash, no nagging)', () => {
    expect(showConnectAiRow(false)).toBe(true);
    expect(showConnectAiRow(true)).toBe(false);
    expect(showConnectAiRow(undefined)).toBe(false);
  });

  it('the toast fires once, on a known not-connected -> connected change, and never again', () => {
    expect(shouldAnnounceMove(false, true, false)).toBe(true);
    expect(shouldAnnounceMove(false, true, true)).toBe(false); // already shown, stored per viewer
    expect(shouldAnnounceMove(true, true, false)).toBe(false); // was already connected: no change to announce
    expect(shouldAnnounceMove(undefined, true, false)).toBe(false); // first look: nothing was seen to disappear
    expect(shouldAnnounceMove(false, false, false)).toBe(false);
    expect(shouldAnnounceMove(false, true, undefined)).toBe(false); // the viewer's list is not loaded yet
  });
});
