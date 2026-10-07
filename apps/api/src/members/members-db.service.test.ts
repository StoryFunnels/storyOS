import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { DatabasesService } from '../databases/databases.service';
import type { FieldsService } from '../fields/fields.service';
import type { RecordsService } from '../records/records.service';
import type { SpacesService } from '../workspaces/spaces.service';
import { MembersDbService } from './members-db.service';

/** A drizzle "Failed query" error wraps the driver's DatabaseError in `.cause`
 * (see databases.service.ts's isSlugUniqueViolation, the same shape this
 * mirrors) — reproduced here rather than importing pg, to keep this a plain
 * unit test. */
function uniqueViolation(constraint: string) {
  const err = new Error('Failed query: insert into "fields" ...');
  (err as unknown as { cause: unknown }).cause = { code: '23505', constraint };
  return err;
}

function buildService(opts: { existing?: unknown; createImpl?: () => Promise<unknown> }) {
  const db = {
    query: {
      fields: { findFirst: vi.fn().mockResolvedValue(opts.existing ?? null) },
    },
  } as unknown as Db;
  const create = vi.fn(opts.createImpl ?? (() => Promise.resolve({})));
  const fields = { create } as unknown as FieldsService;
  const service = new MembersDbService(
    db,
    {} as unknown as DatabasesService,
    fields,
    {} as unknown as RecordsService,
    {} as unknown as SpacesService,
  );
  return { service, create };
}

/** ensureField is private — exercised directly, matching this repo's own
 * convention (comments.service.mention-email.test.ts) for a send/write point
 * that would otherwise need re-implementing an unrelated transaction to reach
 * through the public surface. */
function callEnsureField(service: MembersDbService, databaseId: string, apiName: string, spec: unknown) {
  return (
    service as unknown as { ensureField: (d: string, a: string, s: unknown) => Promise<void> }
  ).ensureField(databaseId, apiName, spec);
}

describe('MembersDbService.ensureField (#529)', () => {
  it('creates the field when it does not exist', async () => {
    const { service, create } = buildService({ existing: null });
    await callEnsureField(service, 'db1', 'email', { display_name: 'Email', type: 'email', config: {} });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the field already exists — never calls create', async () => {
    const { service, create } = buildService({ existing: { id: 'f1' } });
    await callEnsureField(service, 'db1', 'email', { display_name: 'Email', type: 'email', config: {} });
    expect(create).not.toHaveBeenCalled();
  });

  it('a lost race (fields_database_api_name_uq violation) resolves successfully, not an error', async () => {
    const { service } = buildService({
      existing: null,
      createImpl: () => Promise.reject(uniqueViolation('fields_database_api_name_uq')),
    });
    await expect(
      callEnsureField(service, 'db1', 'email', { display_name: 'Email', type: 'email', config: {} }),
    ).resolves.toBeUndefined();
  });

  it('an UNRELATED unique violation still propagates — only this exact constraint is swallowed', async () => {
    const { service } = buildService({
      existing: null,
      createImpl: () => Promise.reject(uniqueViolation('some_other_constraint')),
    });
    await expect(
      callEnsureField(service, 'db1', 'email', { display_name: 'Email', type: 'email', config: {} }),
    ).rejects.toThrow();
  });

  it('a non-race error (e.g. validation) still propagates untouched', async () => {
    const { service } = buildService({
      existing: null,
      createImpl: () => Promise.reject(new Error('display name already in use')),
    });
    await expect(
      callEnsureField(service, 'db1', 'email', { display_name: 'Email', type: 'email', config: {} }),
    ).rejects.toThrow('display name already in use');
  });

  it('two concurrent calls for the same field both resolve — the loser hits the race path, not an unhandled throw', async () => {
    const { service } = buildService({
      existing: null,
      createImpl: () => Promise.reject(uniqueViolation('fields_database_api_name_uq')),
    });
    const spec = { display_name: 'Email', type: 'email', config: {} };
    const results = await Promise.allSettled([
      callEnsureField(service, 'db1', 'email', spec),
      callEnsureField(service, 'db1', 'email', spec),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});
