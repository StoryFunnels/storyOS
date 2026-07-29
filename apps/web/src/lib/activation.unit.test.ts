import { describe, expect, it } from 'vitest';
import {
  buildActivationSteps,
  completedCount,
  isActivationComplete,
  isWorkspaceDismissed,
  shouldShowChecklist,
  withWorkspaceDismissed,
  type OnboardingState,
} from './activation';

const EMPTY: OnboardingState = {
  database_created: false,
  records_added: false,
  teammate_invited: false,
  board_view_built: false,
  relation_created: false,
  ai_connected: false,
  business_pack_installed: false,
};

const ALL_DONE: OnboardingState = {
  database_created: true,
  records_added: true,
  teammate_invited: true,
  board_view_built: true,
  relation_created: true,
  ai_connected: true,
  business_pack_installed: true,
};

describe('buildActivationSteps', () => {
  it('maps each real-state flag onto its step, in activation order', () => {
    const steps = buildActivationSteps(EMPTY, { ws: 'w1' });
    expect(steps.map((s) => s.key)).toEqual([
      'database_created',
      'records_added',
      'board_view_built',
      'relation_created',
      'teammate_invited',
      'ai_connected',
      'business_pack_installed',
    ]);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('auto-checks steps from state (given state → which steps done)', () => {
    const steps = buildActivationSteps(
      { ...EMPTY, database_created: true, records_added: true },
      { ws: 'w1', firstDbId: 'db9' },
    );
    const done = steps.filter((s) => s.done).map((s) => s.key);
    expect(done).toEqual(['database_created', 'records_added']);
    expect(completedCount(steps)).toBe(2);
  });

  it('deep-links record/view/relation steps to the first database when present', () => {
    const steps = buildActivationSteps(EMPTY, { ws: 'w1', firstDbId: 'db9' });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.href]));
    expect(byKey.records_added).toBe('/w/w1/d/db9');
    expect(byKey.board_view_built).toBe('/w/w1/d/db9');
    expect(byKey.relation_created).toBe('/w/w1/d/db9');
    expect(byKey.teammate_invited).toBe('/w/w1/settings/members');
    expect(byKey.ai_connected).toBe('/w/w1/settings/api');
    expect(byKey.business_pack_installed).toBe('/w/w1/packs');
  });

  it('leaves db-scoped steps without an href until a database exists', () => {
    const steps = buildActivationSteps(EMPTY, { ws: 'w1' });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.href]));
    expect(byKey.records_added).toBeUndefined();
    expect(byKey.relation_created).toBeUndefined();
  });
});

describe('isActivationComplete / shouldShowChecklist', () => {
  it('is not complete while any step is undone', () => {
    expect(isActivationComplete(buildActivationSteps(EMPTY, { ws: 'w1' }))).toBe(false);
  });

  it('is complete only when every step is done', () => {
    expect(isActivationComplete(buildActivationSteps(ALL_DONE, { ws: 'w1' }))).toBe(true);
  });

  it('shows when there are undone steps and it is not dismissed', () => {
    expect(shouldShowChecklist(buildActivationSteps(EMPTY, { ws: 'w1' }), false)).toBe(true);
  });

  it('hides when dismissed', () => {
    expect(shouldShowChecklist(buildActivationSteps(EMPTY, { ws: 'w1' }), true)).toBe(false);
  });

  it('hides when everything is done, even if not dismissed', () => {
    expect(shouldShowChecklist(buildActivationSteps(ALL_DONE, { ws: 'w1' }), false)).toBe(false);
  });

  it('hides when there are no steps (state not loaded)', () => {
    expect(shouldShowChecklist([], false)).toBe(false);
  });
});

describe('per-workspace dismissal helpers', () => {
  it('detects a dismissed workspace and tolerates an undefined list', () => {
    expect(isWorkspaceDismissed(['w1', 'w2'], 'w1')).toBe(true);
    expect(isWorkspaceDismissed(['w2'], 'w1')).toBe(false);
    expect(isWorkspaceDismissed(undefined, 'w1')).toBe(false);
  });

  it('appends a workspace to the dismissed list without duplicating', () => {
    expect(withWorkspaceDismissed(undefined, 'w1')).toEqual(['w1']);
    expect(withWorkspaceDismissed(['w1'], 'w2')).toEqual(['w1', 'w2']);
    expect(withWorkspaceDismissed(['w1'], 'w1')).toEqual(['w1']);
  });

  it('does not hide another workspace when one is dismissed', () => {
    const dismissed = withWorkspaceDismissed(undefined, 'w1');
    expect(isWorkspaceDismissed(dismissed, 'w1')).toBe(true);
    expect(isWorkspaceDismissed(dismissed, 'w2')).toBe(false);
  });
});
