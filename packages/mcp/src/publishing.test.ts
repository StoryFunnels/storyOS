/**
 * Ticket #456 - the MCP side of the guided "Turn on publishing" flow. It asserts the request the read tool puts on the wire, which scope
 * advertises it, and that there is NO tool for turning publishing on (a person's decision; the route refuses anything that is not one).
 * The API behaviour behind it is tested against a real database in apps/api/test/publishing-setup.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

const WORKSPACE = { id: 'ws-1', name: 'Agency' };
const DATABASE = { id: 'db-1', name: 'Posts', apiSlug: 'posts', fields: [{ id: 'f-name', apiName: 'name', displayName: 'Name', type: 'text' }], views: [] };

function harness(scope: 'read' | 'write' | 'admin' = 'admin') {
  const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const calls: Array<{ method: string; path: string; params: unknown }> = [];
  const server = { registerTool: (name: string, _c: unknown, h: never) => handlers.set(name, h) };
  const GET = async (path: string, opts?: { params?: unknown }) => {
    if (path === '/api/v1/workspaces') return { data: [WORKSPACE] };
    if (path === '/api/v1/workspaces/{ws}/databases') return { data: [DATABASE] };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: DATABASE };
    calls.push({ method: 'GET', path, params: opts?.params });
    return { data: { applicable: true, state: 'not_set_up' } };
  };
  const client = { GET, POST: GET, PUT: GET, PATCH: GET, DELETE: GET } as never;
  registerTools(server as never, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope, allowRunButton: true });
  return { handlers, calls };
}

describe('publishing setup tool (ticket #456)', () => {
  it('get_publishing_setup reads the setup of the named database', async () => {
    const { handlers, calls } = harness('read');
    const res = await handlers.get('get_publishing_setup')!({ workspace: 'Agency', database: 'posts' });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/workspaces/{ws}/databases/{db}/publishing', params: { path: { ws: 'ws-1', db: 'db-1' } } }]);
  });

  it('there is no tool that turns publishing on, at any scope', () => {
    for (const scope of ['read', 'write', 'admin'] as const) {
      expect([...harness(scope).handlers.keys()].filter((n) => /publishing/.test(n))).toEqual(['get_publishing_setup']);
    }
  });
});
