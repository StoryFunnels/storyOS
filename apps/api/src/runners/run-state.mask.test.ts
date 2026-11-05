import { describe, expect, it } from 'vitest';
import { maskRunState, MASKED_RUNNER_NAME } from './run-state';

describe('maskRunState (ticket #1215)', () => {
  it('replaces the machine name with "a Runner" and drops the tool, keeping every other field', () => {
    expect(maskRunState({ state: 'waiting_for_limit', until: '2026-11-05T10:00:00.000Z', tool: 'claude-code', runner_name: "Owner's MacBook" })).toEqual({
      state: 'waiting_for_limit',
      until: '2026-11-05T10:00:00.000Z',
      runner_name: MASKED_RUNNER_NAME,
    });
  });

  it('adds no Runner where there was none, so "Waiting for a Runner" still reads differently from "Waiting to start"', () => {
    expect(maskRunState({ state: 'waiting_for_runner' })).toEqual({ state: 'waiting_for_runner' });
    expect(maskRunState({ state: 'done' })).toEqual({ state: 'done' });
  });
});
