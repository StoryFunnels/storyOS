import { describe, expect, it } from 'vitest';
import { readRunnerCounts, runnerNavCount } from './connected-count';
import { settingsNavCounts } from '@/lib/settings-home';
import { deriveSettingsSignals } from '@/lib/settings-signals';
import { settingsCountClass } from '@/lib/settings-menu';

const body = (o: Partial<{ connected_count: number; total_count: number; needs_attention: boolean }> = {}) => ({
  data: [],
  connected_count: 2,
  total_count: 2,
  offline_count: 0,
  at_limit_count: 0,
  needs_attention: false,
  ...o,
});

describe('the Runners row count in the Settings menu (ticket #1321)', () => {
  it('says "N connected" from connected_count, muted when nothing needs attention', () => {
    const c = runnerNavCount(readRunnerCounts(body({ connected_count: 3, total_count: 3 })));
    expect(c).toEqual({ text: '3 connected', warn: false });
    expect(settingsCountClass(c!)).toBe('text-muted');
  });

  it('uses connected_count, not total_count: one of two connected reads "1 connected"', () => {
    expect(runnerNavCount(readRunnerCounts(body({ connected_count: 1, total_count: 2, needs_attention: true })))?.text).toBe('1 connected');
  });

  it('is in the warning colour exactly when needs_attention is true', () => {
    const warn = runnerNavCount(readRunnerCounts(body({ needs_attention: true })))!;
    const calm = runnerNavCount(readRunnerCounts(body({ needs_attention: false })))!;
    expect(settingsCountClass(warn)).toBe('text-warning-text');
    expect(settingsCountClass(calm)).toBe('text-muted');
  });

  it('keeps the warning when zero are connected but some exist (all offline): "0 connected" in warning text', () => {
    const c = runnerNavCount(readRunnerCounts(body({ connected_count: 0, total_count: 1, needs_attention: true })));
    expect(c).toEqual({ text: '0 connected', warn: true });
  });

  it('shows nothing when the person has no Runner (total_count 0)', () => {
    expect(runnerNavCount(readRunnerCounts(body({ connected_count: 0, total_count: 0 })))).toBeUndefined();
  });

  it('shows nothing, never an error or a zero, when the figure is unknown', () => {
    expect(runnerNavCount(undefined)).toBeUndefined();
    expect(readRunnerCounts(undefined)).toBeUndefined();
    expect(readRunnerCounts([])).toBeUndefined(); // an API that returns a bare array carries no counts
    expect(readRunnerCounts({ data: [] })).toBeUndefined(); // predates #1320
    expect(readRunnerCounts({ connected_count: '2', total_count: 2, needs_attention: false })).toBeUndefined();
    expect(readRunnerCounts({ connected_count: 2, total_count: 2 })).toBeUndefined(); // needs_attention missing is not "fine"
    expect(readRunnerCounts({ statusCode: 403, message: 'Guests cannot pair a Runner.' })).toBeUndefined();
  });

  describe('through the menu', () => {
    const counts = (role: string, runners = readRunnerCounts(body({ needs_attention: true }))) =>
      settingsNavCounts(role, deriveSettingsSignals({ runners }, 0));

    it('lands on the runners row for a member and an admin', () => {
      expect(counts('member').runners).toEqual({ text: '2 connected', warn: true });
      expect(counts('admin').runners).toEqual({ text: '2 connected', warn: true });
    });

    it('never lands for a guest, even if the figure were somehow present', () => {
      expect(counts('guest').runners).toBeUndefined();
    });

    it('is absent when the request failed or was refused', () => {
      expect(settingsNavCounts('member', deriveSettingsSignals({}, 0)).runners).toBeUndefined();
    });
  });
});
