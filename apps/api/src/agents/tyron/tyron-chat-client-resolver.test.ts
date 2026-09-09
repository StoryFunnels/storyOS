import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import type { ConnectionsService } from '../../connections/connections.service';
import { TyronChatClientResolver } from './tyron-chat-client-resolver';
import { OpenAiTyronChatClient } from './chat-client';
import type { TyronChatClient } from './chat-client';

/** A fake Db returning a single connections row (or none) to findFirst. */
function makeDb(row: { id: string } | undefined): Db {
  return {
    query: {
      connections: {
        findFirst: async () => row,
      },
    },
  } as unknown as Db;
}

/** A fake ConnectionsService whose getDecryptedAuth returns a fixed auth blob. */
function makeConnectionsService(auth: unknown): ConnectionsService {
  return {
    getDecryptedAuth: async () => ({ provider: 'openai', auth }),
  } as unknown as ConnectionsService;
}

const FAKE_MANAGED_CLIENT: TyronChatClient = { chat: async () => ({ content: '', toolCalls: [], tokensIn: 0, tokensOut: 0 }) };

describe('TyronChatClientResolver.resolve (#352 — Tyron: bring your own AI key)', () => {
  it('uses the workspace\'s own connection when one is active, with source "byo"', async () => {
    const db = makeDb({ id: 'conn_1' });
    const connections = makeConnectionsService({ api_key: 'sk-workspace-own-key', model: 'gpt-4o' });
    const resolver = new TyronChatClientResolver(db, connections);

    const resolved = await resolver.resolve('ws1');

    expect(resolved).toBeDefined();
    expect(resolved!.source).toBe('byo');
    expect(resolved!.model).toBe('gpt-4o');
    expect(resolved!.client).toBeInstanceOf(OpenAiTyronChatClient);
  });

  it('falls back to a default model when the BYO connection has none configured', async () => {
    const db = makeDb({ id: 'conn_1' });
    const connections = makeConnectionsService({ api_key: 'sk-workspace-own-key' });
    const resolver = new TyronChatClientResolver(db, connections);

    const resolved = await resolver.resolve('ws1');

    expect(resolved!.source).toBe('byo');
    expect(resolved!.model).toBeTruthy(); // env()'s OPENAI_MODEL default — a real model tag, not blank
  });

  it('falls back to the managed client when no workspace connection exists', async () => {
    const db = makeDb(undefined);
    const connections = makeConnectionsService(undefined);
    const resolver = new TyronChatClientResolver(db, connections);
    // Swappable seam (same convention as ConnectionsService.fetcher) — avoids
    // depending on env()'s process-wide, cache-once OPENAI_API_KEY, which a
    // mid-test-run process.env mutation cannot reach.
    resolver.resolveManagedClient = () => FAKE_MANAGED_CLIENT;

    const resolved = await resolver.resolve('ws1');

    expect(resolved!.source).toBe('managed');
    expect(resolved!.client).toBe(FAKE_MANAGED_CLIENT);
  });

  it('falls back to the managed client when the connection auth is missing an api_key', async () => {
    const db = makeDb({ id: 'conn_1' });
    const connections = makeConnectionsService({}); // corrupt/empty auth
    const resolver = new TyronChatClientResolver(db, connections);
    resolver.resolveManagedClient = () => FAKE_MANAGED_CLIENT;

    const resolved = await resolver.resolve('ws1');

    expect(resolved!.source).toBe('managed');
  });

  it('returns undefined when neither a workspace connection nor a managed key exists — self-managed, unconfigured', async () => {
    const db = makeDb(undefined);
    const connections = makeConnectionsService(undefined);
    const resolver = new TyronChatClientResolver(db, connections);
    resolver.resolveManagedClient = () => undefined;

    const resolved = await resolver.resolve('ws1');

    expect(resolved).toBeUndefined();
  });
});
