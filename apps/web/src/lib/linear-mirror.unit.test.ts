import { describe, expect, it } from 'vitest';
import {
  INTERVAL_OPTIONS,
  WRITE_BACK_DISCLOSURE,
  dueIn,
  intervalOptionsFor,
  intervalWords,
  mirrorHealth,
  previewProblems,
  previewTotals,
  timeAgo,
  writeBackProblems,
  type PreviewTeam,
  type SyncStatus,
} from './linear-mirror';

const team = (over: Partial<PreviewTeam> = {}): PreviewTeam => ({
  key: 'ENG',
  name: 'Engineering',
  issues: 10,
  linear_issue_total: 10,
  sprints: 1,
  projects: 2,
  issues_by_project: [
    { project_id: 'p1', name: 'Alpha', issues: 6 },
    { project_id: null, name: '(no project)', issues: 4 },
  ],
  ...over,
});

describe('previewProblems', () => {
  it('a team whose numbers all agree has no problems', () => {
    expect(previewProblems(team())).toEqual([]);
  });

  it("a count that differs from Linear's own total is an error that names BOTH numbers", () => {
    const [p] = previewProblems(team({ issues: 148, linear_issue_total: 150, issues_by_project: [{ project_id: null, name: '(no project)', issues: 148 }] }));
    expect(p?.kind).toBe('total_mismatch');
    expect(p?.message).toContain('148');
    expect(p?.message).toContain('150');
  });

  it('per-project counts that do not add up to the team count are an error too', () => {
    const problems = previewProblems(team({ issues_by_project: [{ project_id: 'p1', name: 'Alpha', issues: 3 }] }));
    expect(problems.map((p) => p.kind)).toEqual(['project_sum_mismatch']);
    expect(problems[0]?.message).toMatch(/add up to 3.*team count is 10/);
  });

  it('a preview that cannot be checked is NOT treated as one that passed', () => {
    expect(previewProblems(team({ linear_issue_total: undefined })).map((p) => p.kind)).toEqual(['total_unknown']);
  });

  it('an empty team (0 of 0) is fine, not an error', () => {
    expect(previewProblems(team({ issues: 0, linear_issue_total: 0, issues_by_project: [] }))).toEqual([]);
  });
});

describe('previewTotals', () => {
  it("sums the copy and Linear's total across teams, and says null when any team's total is unknown", () => {
    expect(previewTotals([team(), team({ key: 'OPS', issues: 5, linear_issue_total: 5 })])).toEqual({ issues: 15, linearTotal: 15 });
    expect(previewTotals([team(), team({ key: 'OPS', linear_issue_total: undefined })]).linearTotal).toBeNull();
  });
});

describe('interval options', () => {
  it("match the API's limits and keep a saved non-preset value instead of replacing it", () => {
    expect(Math.min(...INTERVAL_OPTIONS.map((o) => o.minutes))).toBe(15);
    expect(Math.max(...INTERVAL_OPTIONS.map((o) => o.minutes))).toBe(1440);
    expect(intervalOptionsFor(60).length).toBe(INTERVAL_OPTIONS.length);
    const withOdd = intervalOptionsFor(90);
    expect(withOdd.find((o) => o.minutes === 90)?.label).toMatch(/saved/);
    expect(withOdd.map((o) => o.minutes)).toEqual([...withOdd.map((o) => o.minutes)].sort((a, b) => a - b));
  });
  it('words for an interval', () => {
    expect(intervalWords(60)).toBe('hour');
    expect(intervalWords(120)).toBe('2 hours');
    expect(intervalWords(1440)).toBe('24 hours');
    expect(intervalWords(45)).toBe('45 minutes');
  });
});

const sync = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  last_success_at: null, last_attempt_at: null, last_error: null, last_error_at: null,
  consecutive_failures: 0, stale: false, next_due_at: null, last_run: null, running: false, ...over,
});

describe('mirrorHealth', () => {
  it('with the schedule off there is nothing to call stale, even if the server says stale', () => {
    expect(mirrorHealth(false, sync({ stale: true, consecutive_failures: 3 }))).toBe('off');
  });
  it('stale outranks failing; failing outranks ok', () => {
    expect(mirrorHealth(true, sync({ stale: true, consecutive_failures: 2 }))).toBe('stale');
    expect(mirrorHealth(true, sync({ consecutive_failures: 1 }))).toBe('failing');
    expect(mirrorHealth(true, sync())).toBe('ok');
  });
});

describe('time words', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  it('timeAgo', () => {
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo('2026-10-14T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-10-14T11:30:00Z', now)).toBe('30 min ago');
    expect(timeAgo('2026-10-14T06:00:00Z', now)).toBe('6 h ago');
    expect(timeAgo('2026-10-10T12:00:00Z', now)).toBe('4 days ago');
  });
  it('dueIn calls a past time overdue, not scheduled', () => {
    expect(dueIn(null, now)).toBe('—');
    expect(dueIn('2026-10-14T11:00:00Z', now)).toBe('due now');
    expect(dueIn('2026-10-14T12:20:00Z', now)).toBe('in 20 min');
    expect(dueIn('2026-10-14T15:00:00Z', now)).toBe('in 3 h');
  });
});

describe('write-back', () => {
  it('undelivered comments are named, delivered ones are silent', () => {
    expect(writeBackProblems({ enabled: true, pending: 0, failed: 0, last_error: null })).toEqual([]);
    expect(writeBackProblems({ enabled: true, pending: 2, failed: 1, last_error: 'boom' })).toEqual([
      '1 comment could not be delivered to Linear and was given up on.',
      '2 comments are waiting to be delivered.',
    ]);
  });
  it("the disclosure states whose identity, the signature, and that nothing earlier is replayed", () => {
    expect(WRITE_BACK_DISCLOSURE).toMatch(/identity of the API key/);
    expect(WRITE_BACK_DISCLOSURE).toContain('· via StoryOS');
    expect(WRITE_BACK_DISCLOSURE).toMatch(/Comments only/);
    expect(WRITE_BACK_DISCLOSURE).toMatch(/nothing earlier is replayed/);
  });
});
