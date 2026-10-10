import { describe, expect, it } from 'vitest';
import { resolveDatabase } from './resolve.js';
import type { Client } from './client.js';

/**
 * #543 — a credential bound to specific spaces/databases cannot see the rest, and "No database
 * matches" would teach an agent the database does not exist. The message must name the boundary,
 * and must not for an unrestricted credential (where "no match" is the truth).
 */
const fake = (resourceScope: unknown): Client =>
  ({
    GET: async (path: string) =>
      path === '/api/v1/me'
        ? { data: { auth: { resource_scope: resourceScope } } }
        : { data: [{ id: 'db1', name: 'OpenWork', apiSlug: 'openwork', spaceSlug: 'general', qualifiedSlug: 'general/openwork' }] },
  }) as unknown as Client;

describe('resolveDatabase when nothing matches', () => {
  it('a bound credential is told it is the boundary, not that the database is absent', async () => {
    const err = await resolveDatabase(fake({ space_ids: [], database_ids: ['db1'] }), 'ws', 'VaultClients').catch((e: Error) => e);
    expect((err as Error).message).toContain('outside the boundary');
    expect((err as Error).message).toContain('says nothing about whether it exists');
    expect((err as Error).message).not.toContain('No database matches');
  });

  it('an unrestricted credential still gets the plain "no match"', async () => {
    const err = await resolveDatabase(fake(null), 'ws', 'VaultClients').catch((e: Error) => e);
    expect((err as Error).message).toContain('No database matches');
  });

  it('a /me failure fails open to the plain message, never to a false boundary claim', async () => {
    const broken = { GET: async (p: string) => { if (p === '/api/v1/me') throw new Error('down'); return fake(null).GET(p as never); } } as unknown as Client;
    const err = await resolveDatabase(broken, 'ws', 'VaultClients').catch((e: Error) => e);
    expect((err as Error).message).toContain('No database matches');
  });
});
