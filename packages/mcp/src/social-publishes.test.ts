/**
 * Ticket #42 — the MCP side of the per-record publish state, the retry and the account picker. These assert the request each
 * tool puts on the wire (path, ids, body) and which scope advertises it: the retry sends a public post, so a read token
 * must not even see it. The API behaviour behind them is tested against a real database in apps/api/test/social-publishes.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

const WORKSPACE = { id: 'ws-1', name: 'Agency' };
const DATABASE = { id: 'db-1', name: 'Posts', apiSlug: 'posts', fields: [{ id: 'f-name', apiName: 'name', displayName: 'Name', type: 'text' }], views: [] };
const REC = '11111111-1111-4111-8111-111111111111';
const PUBLISH = '22222222-2222-4222-8222-222222222222';

function harness(scope: 'read' | 'write' | 'admin' = 'admin') {
  const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const calls: Array<{ method: string; path: string; params: unknown; body: unknown }> = [];
  const server = { registerTool: (name: string, _c: unknown, h: never) => handlers.set(name, h) };
  const GET = async (path: string, opts?: { params?: unknown }) => {
    if (path === '/api/v1/workspaces') return { data: [WORKSPACE] };
    if (path === '/api/v1/workspaces/{ws}/databases') return { data: [DATABASE] };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: DATABASE };
    calls.push({ method: 'GET', path, params: opts?.params, body: undefined });
    return { data: { data: [] } };
  };
  const POST = async (path: string, opts?: { params?: unknown; body?: unknown }) => {
    calls.push({ method: 'POST', path, params: opts?.params, body: opts?.body });
    return { data: { publish_id: 'new', state: 'queued', retry_of: PUBLISH } };
  };
  const client = { GET, POST, PUT: POST, PATCH: POST, DELETE: POST } as never;
  registerTools(server as never, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope, allowRunButton: true });
  return { handlers, calls };
}

describe('social publishing tools (ticket #42)', () => {
  it('list_social_publishes reads the record\'s publish state by its uuid', async () => {
    const { handlers, calls } = harness();
    const res = await handlers.get('list_social_publishes')!({ workspace: 'Agency', database: 'posts', record: REC });
    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/social-publishes' });
    expect(calls[0]!.params).toEqual({ path: { ws: 'ws-1', db: 'db-1', rec: REC } });
  });

  it('retry_social_publish posts to the failed publish\'s own retry route with an EMPTY body: it cannot be told to use another account', async () => {
    const { handlers, calls } = harness();
    await handlers.get('retry_social_publish')!({ workspace: 'Agency', database: 'posts', record: REC, publish: PUBLISH });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/social-publishes/{publish}/retry', body: {} });
    expect(calls[0]!.params).toEqual({ path: { ws: 'ws-1', db: 'db-1', rec: REC, publish: PUBLISH } });
  });

  it('retry_social_publish has no account or connection argument at all', () => {
    const shapes: Record<string, unknown> = {};
    const server = { registerTool: (name: string, c: { inputSchema?: { shape?: Record<string, unknown> } }) => (shapes[name] = c.inputSchema?.shape ?? c.inputSchema) };
    registerTools(server as never, { client: {}, baseUrl: 'x', token: 't' } as unknown as Ctx, { scope: 'admin', allowRunButton: true });
    expect(Object.keys(shapes['retry_social_publish'] as object).sort()).toEqual(['database', 'publish', 'record', 'workspace']);
  });

  it('list_social_accounts asks for a refresh only when told to', async () => {
    const { handlers, calls } = harness();
    await handlers.get('list_social_accounts')!({ workspace: 'Agency', connection_id: 'c-1' });
    await handlers.get('list_social_accounts')!({ workspace: 'Agency', connection_id: 'c-1', refresh: true });
    expect(calls.map((c) => c.path)).toEqual(Array(2).fill('/api/v1/workspaces/{ws}/connections/{id}/social-accounts'));
    expect(calls[0]!.params).toEqual({ path: { ws: 'ws-1', id: 'c-1' }, query: {} });
    expect(calls[1]!.params).toEqual({ path: { ws: 'ws-1', id: 'c-1' }, query: { refresh: 'true' } });
  });

  it('a read token sees the two reads and NOT the retry (it sends a public post)', () => {
    const { handlers } = harness('read');
    expect(handlers.has('list_social_publishes')).toBe(true);
    expect(handlers.has('list_social_accounts')).toBe(true);
    expect(handlers.has('retry_social_publish')).toBe(false);
    expect(harness('write').handlers.has('retry_social_publish'), 'write is below the retry\'s admin ceiling').toBe(false);
    expect(harness('admin').handlers.has('retry_social_publish')).toBe(true);
  });
});
