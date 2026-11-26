import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

/**
 * Ticket #1363 — identifiers over MCP: the record payload carries `identifier`, `get_record` opens one by identifier alone, the database
 * tools show and set the prefix. Fake data only.
 */
const WS = { id: 'ws-1', name: 'Pinewood' };
const DB_ROW = { id: 'db-1', name: 'Issues', apiSlug: 'issues', qualifiedSlug: 'general/issues', spaceSlug: 'general', identifierPrefix: 'ISSUE' };
const DETAIL = { ...DB_ROW, fields: [], views: [], my_access: 'creator' };
const RECORD = { id: 'rec-1', number: 5201, identifier: 'ISSUE-5201', title: 'Grinder jams', values: {}, database_id: 'db-1' };

type Call = { method: string; path: string; params?: unknown; body?: unknown };

function build(extra: { GET?: (path: string, opts?: { params?: { path?: Record<string, string> } }) => unknown } = {}) {
  const calls: Call[] = [];
  const GET = async (path: string, opts?: { params?: { path?: Record<string, string> } }) => {
    calls.push({ method: 'GET', path, params: opts?.params?.path });
    if (extra.GET) {
      const hit = extra.GET(path, opts);
      if (hit !== undefined) return hit;
    }
    if (path === '/api/v1/workspaces') return { data: [WS] };
    if (path === '/api/v1/workspaces/{ws}/databases') return { data: [DB_ROW] };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: DETAIL };
    if (path === '/api/v1/workspaces/{ws}/records/by-identifier/{identifier}') return { data: RECORD };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}') return { data: { ...RECORD, database_id: undefined } };
    throw new Error(`unmocked GET ${path}`);
  };
  const POST = async (path: string, opts?: { body?: unknown }) => {
    calls.push({ method: 'POST', path, body: opts?.body });
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/query') return { data: { data: [RECORD], next_cursor: null, has_more: false } };
    throw new Error(`unmocked POST ${path}`);
  };
  const PATCH = async (path: string, opts?: { body?: unknown }) => {
    calls.push({ method: 'PATCH', path, body: opts?.body });
    return { data: { ...DETAIL, ...(opts?.body as object) } };
  };
  const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const server = { registerTool: (name: string, _c: unknown, h: never) => handlers.set(name, h) } as unknown as McpServer;
  registerTools(server, { client: { GET, POST, PATCH } as never, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
  const run = async (name: string, args: unknown) => {
    const res = await handlers.get(name)!(args);
    if (res.isError) throw new Error(res.content[0]!.text);
    return JSON.parse(res.content[0]!.text);
  };
  return { run, calls, handlers };
}

describe('get_record by identifier', () => {
  it('needs only the workspace and the identifier, and asks the by-identifier route (not a database)', async () => {
    const { run, calls } = build();
    const rec = await run('get_record', { workspace: 'Pinewood', identifier: 'ISSUE-5201' });
    expect(rec.id).toBe('rec-1');
    expect(rec.identifier).toBe('ISSUE-5201');
    const hit = calls.find((c) => c.path === '/api/v1/workspaces/{ws}/records/by-identifier/{identifier}');
    expect(hit?.params).toEqual({ ws: 'ws-1', identifier: 'ISSUE-5201' });
    // the database list was never consulted: the identifier names its database
    expect(calls.some((c) => c.path === '/api/v1/workspaces/{ws}/databases' && c.method === 'GET')).toBe(false);
  });

  it('upper-cases the prefix before asking (lookup is case-insensitive, the call is canonical)', async () => {
    const { run, calls } = build();
    await run('get_record', { workspace: 'Pinewood', identifier: ' issue-5201 ' });
    expect(calls.find((c) => c.path.endsWith('/by-identifier/{identifier}'))?.params).toEqual({ ws: 'ws-1', identifier: 'ISSUE-5201' });
  });

  it('text that is not an identifier is refused with a message that says what an identifier is, before any request', async () => {
    const { run, calls } = build();
    await expect(run('get_record', { workspace: 'Pinewood', identifier: 'not an id' })).rejects.toThrow(/prefix, a dash and a number/);
    expect(calls.some((c) => c.path.includes('by-identifier'))).toBe(false);
  });

  it('identifier together with database/record is ambiguous and refused', async () => {
    const { run } = build();
    await expect(run('get_record', { workspace: 'Pinewood', database: 'Issues', record: '5201', identifier: 'ISSUE-5201' })).rejects.toThrow(/either/i);
  });

  it('with neither identifier nor database + record it says what to pass', async () => {
    const { run } = build();
    await expect(run('get_record', { workspace: 'Pinewood' })).rejects.toThrow(/identifier/);
    await expect(run('get_record', { workspace: 'Pinewood', database: 'Issues' })).rejects.toThrow(/identifier/);
  });

  it('the old call (database + record number) still works unchanged', async () => {
    const { run } = build();
    const rec = await run('get_record', { workspace: 'Pinewood', database: 'Issues', record: '5201' });
    expect(rec.number).toBe(5201);
  });

  it('a 404 from the API (unknown prefix, hidden database, missing number alike) surfaces as an error, never as a record', async () => {
    const { run } = build({ GET: (path) => (path.endsWith('/by-identifier/{identifier}') ? { error: { error: { code: 'not_found', message: 'Record not found' } } } : undefined) });
    await expect(run('get_record', { workspace: 'Pinewood', identifier: 'NOPE-1' })).rejects.toThrow(/not found/i);
  });
});

describe('the other tools carry the identifier', () => {
  it('query_records returns identifier on every record', async () => {
    const { run } = build();
    const res = await run('query_records', { workspace: 'Pinewood', database: 'Issues' });
    expect(res.records[0].identifier).toBe('ISSUE-5201');
  });

  it('list_databases and describe_database show the prefix, and omit it for a database without one', async () => {
    const { run } = build();
    expect((await run('list_databases', { workspace: 'Pinewood' }))[0].identifier_prefix).toBe('ISSUE');
    expect((await run('describe_database', { workspace: 'Pinewood', database: 'Issues' })).identifier_prefix).toBe('ISSUE');
    const plain = build({ GET: (path) => (path === '/api/v1/workspaces/{ws}/databases' ? { data: [{ ...DB_ROW, identifierPrefix: null }] } : path === '/api/v1/workspaces/{ws}/databases/{db}' ? { data: { ...DETAIL, identifierPrefix: null } } : undefined) });
    expect('identifier_prefix' in (await plain.run('list_databases', { workspace: 'Pinewood' }))[0]).toBe(false);
    expect((await plain.run('describe_database', { workspace: 'Pinewood', database: 'Issues' })).identifier_prefix).toBeUndefined();
  });
});

describe('update_database identifier_prefix', () => {
  it('sends the prefix, and null to remove it', async () => {
    const { run, calls } = build();
    await run('update_database', { workspace: 'Pinewood', database: 'Issues', identifier_prefix: 'ISSUE' });
    await run('update_database', { workspace: 'Pinewood', database: 'Issues', identifier_prefix: null });
    const bodies = calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
    expect(bodies).toEqual([{ identifier_prefix: 'ISSUE' }, { identifier_prefix: null }]);
  });

  it('a malformed prefix is rejected by the tool schema before any request (the API answers 422 for the same shapes)', () => {
    type Field = { safeParse: (v: unknown) => { success: boolean } };
    const schemas = new Map<string, unknown>();
    const server = { registerTool: (n: string, c: { inputSchema?: unknown }) => schemas.set(n, c.inputSchema) } as unknown as McpServer;
    registerTools(server, { client: {} as never, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
    const input = schemas.get('update_database') as { shape?: Record<string, Field> } & Record<string, Field>;
    const field = (input.shape ?? input).identifier_prefix!;
    for (const ok of ['ISSUE', 'SF', 'ENG2', null]) expect(field.safeParse(ok).success, String(ok)).toBe(true);
    for (const bad of ['A', 'issue', '1ABC', 'IS-SUE', 'ELEVENCHARSX', '']) expect(field.safeParse(bad).success, bad).toBe(false);
  });
});
