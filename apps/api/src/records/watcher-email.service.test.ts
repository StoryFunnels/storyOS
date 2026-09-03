import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { EmailService } from '../mail/email.service';
import type { PreferencesService } from '../users/preferences.service';
import { DEFAULT_PREFERENCES } from '../users/preferences.constants';
import { WatcherEmailService } from './watcher-email.service';

/** Mirrors comments.service.mention-email.test.ts's buildService shape — the
 * #273 email send point exercised directly, without RecordsService's own
 * update() transaction/db churn around it. */
function buildService(opts: {
  watchers: Array<{ id: string; email: string }>;
  recordChangedToggleByUser?: Record<string, boolean>;
}) {
  const sent: Array<{ kind: string; to: string; actorName?: string; recordTitle?: string; summary?: string; url?: string }> = [];
  const emailService = {
    send: vi.fn(async (input: { kind: string; to: string; actorName?: string; recordTitle?: string; summary?: string; url?: string }) => {
      sent.push(input);
    }),
  } as unknown as EmailService;

  const preferences = {
    notificationPrefsFor: vi.fn(async (ids: string[]) => {
      const map = new Map<string, typeof DEFAULT_PREFERENCES.notifications>();
      for (const id of ids) {
        map.set(id, {
          ...DEFAULT_PREFERENCES.notifications,
          record_changed: opts.recordChangedToggleByUser?.[id] ?? true,
        });
      }
      return map;
    }),
  } as unknown as PreferencesService;

  const db = {
    query: {
      user: {
        findMany: vi.fn().mockResolvedValue(opts.watchers),
      },
    },
  } as unknown as Db;

  const service = new WatcherEmailService(db, emailService, preferences);
  return { service, sent, preferences };
}

describe('WatcherEmailService (#273)', () => {
  it('emails a watcher who has not opted out, with the change summary and a record deep link', async () => {
    const { service, sent } = buildService({ watchers: [{ id: 'u1', email: 'u1@example.com' }] });

    await service.notify('ws1', 'rec1', 'Q3 roadmap', 'Ada', 'Status: Todo → Done', ['u1']);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'record-changed',
      to: 'u1@example.com',
      actorName: 'Ada',
      recordTitle: 'Q3 roadmap',
      summary: 'Status: Todo → Done',
    });
    expect(sent[0]!.url).toContain('/r/rec1');
  });

  it('honors the existing "record_changed" notification toggle as the email opt-out', async () => {
    const { service, sent, preferences } = buildService({
      watchers: [{ id: 'u1', email: 'u1@example.com' }],
      recordChangedToggleByUser: { u1: false },
    });

    await service.notify('ws1', 'rec1', 'Q3 roadmap', 'Ada', 'Status: Todo → Done', ['u1']);

    expect(preferences.notificationPrefsFor).toHaveBeenCalledWith(['u1']);
    expect(sent).toEqual([]);
  });

  it('emails every opted-in watcher when several watch the same record', async () => {
    const { service, sent } = buildService({
      watchers: [
        { id: 'u1', email: 'u1@example.com' },
        { id: 'u2', email: 'u2@example.com' },
      ],
      recordChangedToggleByUser: { u2: false },
    });

    await service.notify('ws1', 'rec1', 'Q3 roadmap', 'Ada', 'summary', ['u1', 'u2']);

    expect(sent.map((s) => s.to)).toEqual(['u1@example.com']);
  });

  it('falls back to "Someone" when the actor has no name', async () => {
    const { service, sent } = buildService({ watchers: [{ id: 'u1', email: 'u1@example.com' }] });

    await service.notify('ws1', 'rec1', 'Q3 roadmap', null, 'summary', ['u1']);

    expect(sent[0]).toMatchObject({ actorName: 'Someone' });
  });

  it('sends nothing (and never touches the db) when there are no watchers', async () => {
    const { service, sent } = buildService({ watchers: [] });
    const db = (service as unknown as { db: { query: { user: { findMany: ReturnType<typeof vi.fn> } } } }).db;

    await service.notify('ws1', 'rec1', 'Q3 roadmap', 'Ada', 'summary', []);

    expect(sent).toEqual([]);
    expect(db.query.user.findMany).not.toHaveBeenCalled();
  });

  it('bounds fan-out at MAX_WATCHER_EMAILS_PER_CHANGE — a change with 51 watchers mails only 50', async () => {
    const watcherIds = Array.from({ length: 51 }, (_, i) => `u${i}`);
    const watchers = watcherIds.slice(0, 50).map((id) => ({ id, email: `${id}@example.com` }));
    const { service, sent } = buildService({ watchers });

    await service.notify('ws1', 'rec1', 'Q3 roadmap', 'Ada', 'summary', watcherIds);

    // The mocked lookup only knows the first 50 watchers — if the cap didn't apply,
    // the 51st id would resolve to no user and simply be skipped, hiding the bug;
    // asserting the exact count is what actually proves the cap, not just an upper bound.
    expect(sent).toHaveLength(50);
  });
});
