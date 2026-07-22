import { describe, expect, it } from 'vitest';
import { buildIdempotencyKey, JobRunnerService } from './job-runner.service';

describe('buildIdempotencyKey (MN-253)', () => {
  it('composes ruleId:recordId:runId:actionIndex', () => {
    expect(
      buildIdempotencyKey({ ruleId: 'rule-1', recordId: 'rec-1', runId: 'run-1', actionIndex: 2 }),
    ).toBe('rule-1:rec-1:run-1:2');
  });

  it('placeholders a missing ruleId/recordId rather than colliding across them', () => {
    // A webhook_received rule run has no record; a job enqueued outside a
    // rule has no rule. Both must stay distinguishable from a real id string.
    const noRule = buildIdempotencyKey({ ruleId: null, recordId: 'rec-1', runId: 'run-1', actionIndex: 0 });
    const noRecord = buildIdempotencyKey({ ruleId: 'rule-1', recordId: null, runId: 'run-1', actionIndex: 0 });
    expect(noRule).toBe('norule:rec-1:run-1:0');
    expect(noRecord).toBe('rule-1:norecord:run-1:0');
    expect(noRule).not.toBe(noRecord);
  });

  it('two different action indices in the same run never collide', () => {
    const a = buildIdempotencyKey({ ruleId: 'r', recordId: 'x', runId: 'run', actionIndex: 0 });
    const b = buildIdempotencyKey({ ruleId: 'r', recordId: 'x', runId: 'run', actionIndex: 1 });
    expect(a).not.toBe(b);
  });
});

/**
 * The executor registry is plain in-memory state — no DB call happens until
 * enqueue()/tick() run, so these are exercised without a database. The
 * claim/retry/breaker/rate-limit/reaper behavior lives in
 * test/automation-jobs.test.ts (integration, against a real Postgres).
 */
describe('JobRunnerService executor registry (no DB)', () => {
  function newService(): JobRunnerService {
    // DB/ConnectionsService/NotificationsService/CommentsService are never
    // touched by registerExecutor/hasExecutor — safe to pass placeholders.
    return new JobRunnerService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  it('hasExecutor is false until registerExecutor is called for that kind', () => {
    const jobs = newService();
    expect(jobs.hasExecutor('test.echo')).toBe(false);
    jobs.registerExecutor('test.echo', async (payload) => payload);
    expect(jobs.hasExecutor('test.echo')).toBe(true);
    expect(jobs.hasExecutor('test.something_else')).toBe(false);
  });

  it('no kind from the current action schema is ever pre-registered', () => {
    // actions.service.ts's execute() routes a kind through the queue only
    // once something calls registerExecutor for it — none of the seven
    // existing AutomationAction kinds (set_values, create_record, …) do,
    // so this stays false for all of them until MN-256+ lands.
    const jobs = newService();
    for (const kind of [
      'set_values',
      'create_record',
      'add_comment',
      'notify_user',
      'update_linked',
      'send_slack_message',
      'send_webhook',
    ]) {
      expect(jobs.hasExecutor(kind)).toBe(false);
    }
  });
});
