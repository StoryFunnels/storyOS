/**
 * #458 — does `link_records` hit the same 500 the REST route did?
 *
 * Otto asked for this to be established rather than argued: if the MCP tool
 * put a field api_name into the `{field}` path segment, the bug would have
 * affected every agent in the fleet, not only REST callers — and the house
 * rules point every agent at exactly this tool.
 *
 * The answer is no, and the reason is mechanical: link_records resolves the
 * `relation_field` argument (api_name, display name, or id) against the
 * database detail it has already fetched, and puts the resolved UUID on the
 * wire. So it never sent the shape that reached Postgres as a uuid comparand.
 *
 * These tests assert the request PATH, because the path is the thing that
 * decided whether the bug was reachable. Asserting the tool "works" against a
 * fake API would prove nothing here — the fake would happily accept an
 * api_name that the real route rejected.
 */
import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

const WORKSPACE = { id: 'ws-1', name: 'Agency' };
const DATABASE = {
  id: 'db-1',
  name: 'Issues',
  apiSlug: 'issues',
  fields: [
    { id: 'f-name', apiName: 'name', displayName: 'Name', type: 'text' },
    {
      id: '9f976253-441d-4479-b8e7-299106af9a37',
      apiName: 'agents',
      displayName: 'Agents',
      type: 'relation',
      relation: { target_database_id: 'db-1', cardinality: 'many_to_many', side: 'a' },
    },
  ],
  views: [],
};
const ROW = { id: 'rec-1', number: 1, title: 'A record', values: {} };

function harness() {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const calls: Array<{ method: string; path: string; field: unknown; body: unknown }> = [];
  const server = {
    registerTool: (name: string, _c: unknown, h: (args: unknown) => Promise<unknown>) => handlers.set(name, h),
  };
  const GET = async (path: string) => {
    if (path === '/api/v1/workspaces') return { data: [WORKSPACE] };
    if (path === '/api/v1/workspaces/{ws}/databases') return { data: [DATABASE] };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: DATABASE };
    if (path.endsWith('/records/{rec}')) return { data: ROW };
    if (path.endsWith('/links/{field}')) return { data: [] };
    return { data: [] };
  };
  const record = (method: string) => async (path: string, opts: { params?: { path?: Record<string, unknown> }; body?: unknown }) => {
    calls.push({ method, path, field: opts?.params?.path?.field, body: opts?.body });
    return { data: ROW };
  };
  const client = { GET, POST: record('POST'), PUT: record('PUT'), PATCH: record('PATCH'), DELETE: record('DELETE') } as never;
  registerTools(server as never, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
  return { handlers, calls };
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const base = { workspace: 'Agency', database: 'issues', record: '1' };

describe('#458 — link_records never puts an api_name in the {field} path segment', () => {
  it('resolves an api_name to the field UUID before calling (add)', async () => {
    const { handlers, calls } = harness();
    await handlers.get('link_records')!({ ...base, relation_field: 'agents', targets: ['1'] });
    const linkCall = calls.find((c) => c.path.includes('/links/{field}'))!;
    expect(linkCall, 'link_records issued a links call').toBeTruthy();
    expect(linkCall.field, 'the path segment is the UUID, never "agents"').toBe(
      '9f976253-441d-4479-b8e7-299106af9a37',
    );
    expect(String(linkCall.field)).toMatch(UUID);
    expect(linkCall.method).toBe('POST');
  });

  it('does the same on replace, which is the PUT verb Vera saw 500', async () => {
    const { handlers, calls } = harness();
    await handlers.get('link_records')!({ ...base, relation_field: 'agents', targets: ['1'], replace: true });
    const linkCall = calls.find((c) => c.path.includes('/links/{field}'))!;
    expect(linkCall.method).toBe('PUT');
    expect(String(linkCall.field)).toMatch(UUID);
  });

  it('and on unlink_records, the DELETE verb', async () => {
    const { handlers, calls } = harness();
    await handlers.get('unlink_records')!({ ...base, relation_field: 'agents', targets: ['1'] });
    const linkCall = calls.find((c) => c.path.includes('/links/{field}'))!;
    expect(linkCall.method).toBe('DELETE');
    expect(String(linkCall.field)).toMatch(UUID);
  });

  it('a display name resolves too — still a UUID on the wire', async () => {
    const { handlers, calls } = harness();
    await handlers.get('link_records')!({ ...base, relation_field: 'Agents', targets: ['1'] });
    const linkCall = calls.find((c) => c.path.includes('/links/{field}'))!;
    expect(String(linkCall.field)).toMatch(UUID);
  });

  it('an unknown relation field fails in the TOOL, before any request is made', async () => {
    // The failure an agent should get is "no such field on this database",
    // named locally — not whatever the API would have said about it.
    const { handlers, calls } = harness();
    const res = (await handlers.get('link_records')!({
      ...base,
      relation_field: 'nosuchfield',
      targets: ['1'],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError, 'an unknown field is an error, not a silent no-op').toBe(true);
    expect(res.content[0]!.text).toMatch(/nosuchfield/i);
    expect(calls.filter((c) => c.path.includes('/links/{field}')), 'no request was made').toHaveLength(0);
  });
});
