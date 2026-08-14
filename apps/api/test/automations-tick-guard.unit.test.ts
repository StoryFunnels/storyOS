import { describe, expect, it, vi } from 'vitest';
import { AutomationsService } from '../src/automations/automations.service';

/**
 * The scheduler fires as `setInterval(() => void this.tick(), 60_000)` — an untracked
 * callback. An uncaught rejection there is fatal to the whole Node process, so a
 * transient Postgres blip would take the entire API down, not just automations.
 *
 * WebhooksService.tick() has always guarded against this; automations was the
 * outlier. This test is the guard against it drifting back.
 */
describe('AutomationsService.tick — a DB blip must never crash the process', () => {
  function serviceWithFailingDb() {
    const db = {
      query: {
        automations: {
          findMany: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
        },
      },
    } as unknown as ConstructorParameters<typeof AutomationsService>[0];
    const approvals = { expireStale: vi.fn().mockResolvedValue(undefined) };
    const svc = new AutomationsService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      approvals as never,
      {} as never,
    );
    return svc;
  }

  it('resolves instead of rejecting when the query throws', async () => {
    const svc = serviceWithFailingDb();
    // The assertion IS "does not reject" — an unhandled rejection here is a
    // process-level crash in production.
    await expect(svc.tick()).resolves.toBeUndefined();
  });
});
