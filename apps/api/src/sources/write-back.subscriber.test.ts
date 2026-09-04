import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { ConnectionsService } from '../connections/connections.service';
import type { DomainEvent, DomainEventsService } from '../events/domain-events.service';
import { SOURCE_PROVIDER_REGISTRY } from './providers';
import type { SourceProviderDescriptor } from './providers';
import { WriteBackSubscriber } from './write-back.subscriber';

const FAKE_PROVIDER_ID = 'test.write-back-fixture';

/** Registers a fake provider (with or without push()) for the duration of one
 * test, then removes it — SOURCE_PROVIDER_REGISTRY is a module-level Map,
 * shared across the whole process, so leaking an entry would bleed into
 * unrelated tests (e.g. listProviders() suites) that iterate its keys. */
function withFakeProvider(
  push: SourceProviderDescriptor['push'] | undefined,
  run: (descriptor: SourceProviderDescriptor) => Promise<void>,
) {
  const descriptor = {
    id: FAKE_PROVIDER_ID,
    label: 'Write-back fixture',
    connectionProvider: 'google',
    configSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    sync: vi.fn(),
    ...(push ? { push } : {}),
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
  fieldMapping: Record<string, unknown>;
  recordValues: Record<string, unknown> | undefined;
  connectionId?: string | null;
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
            connectionId: opts.connectionId === undefined ? 'conn1' : opts.connectionId,
            externalKeyFieldId: opts.externalKeyFieldId,
            fieldMapping: opts.fieldMapping,
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
  const connectionsService = {
    getDecryptedAuth: vi.fn().mockResolvedValue({ auth: { token: 'fake' }, provider: 'google' }),
  } as unknown as ConnectionsService;
  const subscriber = new WriteBackSubscriber(db, domainEvents, connectionsService);
  return { subscriber, inserted, connectionsService };
}

const baseEvent: DomainEvent = {
  type: 'record_updated',
  workspaceId: 'ws1',
  databaseId: 'db1',
  recordId: 'rec1',
  changedFieldIds: ['field_x'],
  changedValues: { field_x: { from: 'old', to: 'new-value' } },
  actorId: 'user1',
  depth: 0,
};

/** pushChanges is private — exercised directly, matching this repo's
 * established convention for a fire-and-forget handler's actual work. */
function callPushChanges(subscriber: WriteBackSubscriber, event: DomainEvent) {
  return (subscriber as unknown as { pushChanges: (e: DomainEvent) => Promise<void> }).pushChanges(event);
}

describe('WriteBackSubscriber (#279/#281, real push)', () => {
  afterEach(() => {
    (SOURCE_PROVIDER_REGISTRY as unknown as Map<string, SourceProviderDescriptor>).delete(FAKE_PROVIDER_ID);
  });

  it('pushes when write_back is on, the changed field is mapped out, and the record carries the external key', async () =>
    withFakeProvider(vi.fn().mockResolvedValue({ stats: { ok: true } }), async (descriptor) => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).toHaveBeenCalledWith(
        expect.objectContaining({ externalKey: 'remote-123', values: { out_key: 'new-value' } }),
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        sourceId: 'source1',
        workspaceId: 'ws1',
        status: 'ok',
        stats: expect.objectContaining({ pushed: true, record_id: 'rec1', external_key: 'remote-123', ok: true }),
      });
    }));

  it('prefers the event\'s changedValues.to over the record\'s current stored value', async () =>
    withFakeProvider(vi.fn().mockResolvedValue({ stats: {} }), async (descriptor) => {
      const { subscriber } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        // record's CURRENT stored value differs from the event's `to` — the
        // event is the authoritative "what this write actually set it to".
        recordValues: { ext_field: 'remote-123', field_x: 'stale-current-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).toHaveBeenCalledWith(expect.objectContaining({ values: { out_key: 'new-value' } }));
    }));

  it('an in-mapped field edit pushes nothing — no outbound call at all', async () =>
    withFakeProvider(vi.fn(), async (descriptor) => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', in_key: { field_id: 'field_x', direction: 'in' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    }));

  it('a "both"-mapped field edit pushes, exactly like "out"', async () =>
    withFakeProvider(vi.fn().mockResolvedValue({ stats: {} }), async (descriptor) => {
      const { subscriber } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', both_key: { field_id: 'field_x', direction: 'both' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).toHaveBeenCalledWith(expect.objectContaining({ values: { both_key: 'new-value' } }));
    }));

  it('a changed field this source does not map at all pushes nothing', async () =>
    withFakeProvider(vi.fn(), async (descriptor) => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'some-other-field', direction: 'out' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    }));

  it('write_back OFF (default) never attempts one — no outbound call, no run row, regardless of push() support', async () =>
    withFakeProvider(vi.fn(), async (descriptor) => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: {}, // write_back absent — defaults off
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    }));

  it('a provider without push() never attempts one, even with write_back on and an out-mapped changed field', async () =>
    withFakeProvider(undefined, async () => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(inserted).toEqual([]);
    }));

  it('a record with no value at the external key field is not yet owned by the source — nothing pushed', async () =>
    withFakeProvider(vi.fn(), async (descriptor) => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        recordValues: { field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    }));

  it('a rejected push lands as an errored source_runs row naming the provider error, and nothing else is touched', async () =>
    withFakeProvider(vi.fn().mockRejectedValue(new Error('Shopify rejected the product update: bad status value')), async () => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      await callPushChanges(subscriber, baseEvent);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        sourceId: 'source1',
        status: 'error',
        error: expect.stringContaining('Shopify rejected the product update'),
      });
    }));

  it('a source with no connection never attempts a push', async () =>
    withFakeProvider(vi.fn(), async (descriptor) => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
        connectionId: null,
      });
      await callPushChanges(subscriber, baseEvent);
      expect(descriptor.push).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    }));

  it('ignores events for a different type entirely (only record_updated triggers a lookup)', async () =>
    withFakeProvider(vi.fn(), async (descriptor) => {
      const { subscriber, inserted } = buildSubscriber({
        sourceConfig: { write_back: true },
        providerSource: FAKE_PROVIDER_ID,
        externalKeyFieldId: 'ext_field',
        fieldMapping: { ext_field: 'ext_field', out_key: { field_id: 'field_x', direction: 'out' } },
        recordValues: { ext_field: 'remote-123', field_x: 'new-value' },
      });
      // handle() is the public entry point that filters by event.type; calling
      // it directly (rather than pushChanges) proves the filter itself.
      (subscriber as unknown as { handle: (e: DomainEvent) => void }).handle({
        ...baseEvent,
        type: 'record_created',
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(descriptor.push).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    }));
});
