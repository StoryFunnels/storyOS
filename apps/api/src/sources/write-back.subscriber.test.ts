import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { DomainEvent, DomainEventsService } from '../events/domain-events.service';
import { SOURCE_PROVIDER_REGISTRY } from './providers';
import type { SourceProviderDescriptor } from './providers';
import { WriteBackSubscriber } from './write-back.subscriber';

const FAKE_PROVIDER_ID = 'test.write-back-fixture';

/** Registers a fake provider (with or without push()) for the duration of one
 * test, then removes it — SOURCE_PROVIDER_REGISTRY is a module-level Map,
 * shared across the whole process, so leaking an entry would bleed into
 * unrelated tests (e.g. listProviders() suites) that iterate its keys. */
function withFakeProvider(hasPush: boolean, run: (descriptor: SourceProviderDescriptor) => Promise<void>) {
  const descriptor = {
    id: FAKE_PROVIDER_ID,
    label: 'Write-back fixture',
    connectionProvider: 'google',
    configSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    sync: vi.fn(),
    ...(hasPush ? { push: vi.fn() } : {}),
  } as unknown as SourceProviderDescriptor;
  (SOURCE_PROVIDER_REGISTRY as unknown as Map<string, SourceProviderDescriptor>).set(FAKE_PROVIDER_ID, descriptor);
  return run(descriptor).finally(() => {
    (SOURCE_PROVIDER_REGISTRY as unknown as Map<string, SourceProviderDescriptor>).delete(FAKE_PROVIDER_ID);
  });
}

function buildSubscriber(opts: {
  sourceConfig: Record<string, unknown>;
  providerSource: string;
  externalKeyFieldId: string;
  recordValues: Record<string, unknown> | undefined;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    query: {
      sources: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'source1',
            workspaceId: 'ws1',
            targetDatabaseId: 'db1',
            providerSource: opts.providerSource,
            externalKeyFieldId: opts.externalKeyFieldId,
            config: opts.sourceConfig,
          },
        ]),
      },
      records: {
        findFirst: vi.fn().mockResolvedValue(opts.recordValues ? { values: opts.recordValues } : undefined),
      },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
  const domainEvents = { subscribe: vi.fn() } as unknown as DomainEventsService;
  const subscriber = new WriteBackSubscriber(db, domainEvents);
  return { subscriber, inserted };
}

const baseEvent: DomainEvent = {
  type: 'record_updated',
  workspaceId: 'ws1',
  databaseId: 'db1',
  recordId: 'rec1',
  changedFieldIds: ['field_x'],
  actorId: 'user1',
  depth: 0,
};

/** logIntendedPushes is private — exercised directly, matching this repo's
 * established convention for a fire-and-forget handler's actual work. */
function callLogIntendedPushes(subscriber: WriteBackSubscriber, event: DomainEvent) {
  return (
    subscriber as unknown as { logIntendedPushes: (e: DomainEvent) => Promise<void> }
  ).logIntendedPushes(event);
}

describe('WriteBackSubscriber (#279, dry-run)', () => {
  afterEach(() => {
    (SOURCE_PROVIDER_REGISTRY as unknown as Map<string, SourceProviderDescriptor>).delete(FAKE_PROVIDER_ID);
  });

  it('logs the intended push when write_back is on, the provider supports push, and the record carries the external key', async () =>
    withFakeProvider(true, async () => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        recordValues: { ext_field: 'remote-123' },
      });
      await callLogIntendedPushes(subscriber, baseEvent);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        sourceId: 'source1',
        workspaceId: 'ws1',
        status: 'push_dry_run',
        stats: expect.objectContaining({ would_push: true, record_id: 'rec1', external_key: 'remote-123' }),
      });
    }));

  it('never calls descriptor.push() — this slice only logs, it does not push', async () =>
    withFakeProvider(true, async (descriptor) => {
      const { subscriber } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        recordValues: { ext_field: 'remote-123' },
      });
      await callLogIntendedPushes(subscriber, baseEvent);
      expect(descriptor.push).not.toHaveBeenCalled();
    }));

  it('write_back OFF (default) never attempts one — no run row, regardless of push() support', async () =>
    withFakeProvider(true, async () => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: {}, // write_back absent — defaults off
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        recordValues: { ext_field: 'remote-123' },
      });
      await callLogIntendedPushes(subscriber, baseEvent);
      expect(inserted).toEqual([]);
    }));

  it('a provider without push() never attempts one, even with write_back on', async () =>
    withFakeProvider(false, async () => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        recordValues: { ext_field: 'remote-123' },
      });
      await callLogIntendedPushes(subscriber, baseEvent);
      expect(inserted).toEqual([]);
    }));

  it('a record with no value at the external key field is not yet owned by the source — nothing logged', async () =>
    withFakeProvider(true, async () => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        recordValues: { some_other_field: 'x' },
      });
      await callLogIntendedPushes(subscriber, baseEvent);
      expect(inserted).toEqual([]);
    }));

  it('ignores events for a different type entirely (only record_updated triggers a lookup)', async () =>
    withFakeProvider(true, async () => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        recordValues: { ext_field: 'remote-123' },
      });
      // handle() is the public entry point that filters by event.type; calling
      // it directly (rather than logIntendedPushes) proves the filter itself.
      (subscriber as unknown as { handle: (e: DomainEvent) => void }).handle({
        ...baseEvent,
        type: 'record_created',
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(inserted).toEqual([]);
    }));
});
