import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { AiCreditsService } from './ai-credits.service';
import { AutoReloadRetryService } from './auto-reload-retry.service';

function makeDb(candidates: Array<{ workspaceId: string }>) {
  return {
    query: {
      aiCreditBalances: { findMany: vi.fn().mockResolvedValue(candidates) },
    },
  } as unknown as Db;
}

describe('AutoReloadRetryService.sweep', () => {
  it('retries every workspace whose backoff has elapsed', async () => {
    const db = makeDb([{ workspaceId: 'ws1' }, { workspaceId: 'ws2' }]);
    const tryAutoReload = vi.fn().mockResolvedValue('succeeded');
    const svc = new AutoReloadRetryService(db, { tryAutoReload } as unknown as AiCreditsService);

    await svc.sweep();

    expect(tryAutoReload).toHaveBeenCalledTimes(2);
    expect(tryAutoReload).toHaveBeenCalledWith('ws1');
    expect(tryAutoReload).toHaveBeenCalledWith('ws2');
  });

  it('does nothing when no workspace is due for a retry', async () => {
    const db = makeDb([]);
    const tryAutoReload = vi.fn();
    const svc = new AutoReloadRetryService(db, { tryAutoReload } as unknown as AiCreditsService);

    await svc.sweep();

    expect(tryAutoReload).not.toHaveBeenCalled();
  });

  it('one workspace erroring does not stop the rest of the sweep', async () => {
    const db = makeDb([{ workspaceId: 'ws1' }, { workspaceId: 'ws2' }]);
    const tryAutoReload = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('succeeded');
    const svc = new AutoReloadRetryService(db, { tryAutoReload } as unknown as AiCreditsService);

    await expect(svc.sweep()).resolves.toBeUndefined();
    expect(tryAutoReload).toHaveBeenCalledTimes(2);
  });
});
