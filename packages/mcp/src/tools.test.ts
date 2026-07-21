import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setIconName } from '@storyos/schemas/icons';
import { filterOpSchema, queryRecordsSchema } from '@storyos/schemas';
import { buildIconCatalog, FILTER_GUIDE, ICON_PARAM_DESCRIPTION, mapFilterValues, OPS_BY_FIELD_TYPE, registerTools } from './tools.js';
import type { Ctx } from './client.js';

// Minimal DatabaseDetail with a select and a person field.
const detail = {
  id: 'db1',
  name: 'Issues',
  fields: [
    {
      apiName: 'priority',
      type: 'select',
      options: [
        { id: 'opt-urgent', label: 'Urgent' },
        { id: 'opt-high', label: 'High' },
      ],
    },
    { apiName: 'assignee', type: 'user' },
    { apiName: 'title', type: 'text' },
  ],
} as never;

describe('mapFilterValues (#204)', () => {
  it('translates eq on a select to has over an id array, mapping the label', () => {
    const out = mapFilterValues(detail, { field: 'priority', op: 'eq', value: 'Urgent' });
    expect(out).toEqual({ field: 'priority', op: 'has', value: ['opt-urgent'] });
  });

  it('translates neq to has_none', () => {
    const out = mapFilterValues(detail, { field: 'priority', op: 'neq', value: 'High' });
    expect(out).toEqual({ field: 'priority', op: 'has_none', value: ['opt-high'] });
  });

  it('recurses into grouped and/or filters', () => {
    const out = mapFilterValues(detail, {
      and: [{ field: 'priority', op: 'eq', value: 'urgent' }],
    });
    expect(out).toEqual({ and: [{ field: 'priority', op: 'has', value: ['opt-urgent'] }] });
  });

  it('maps the @me sentinel on a person field', () => {
    const out = mapFilterValues(detail, { field: 'assignee', op: 'eq', value: '@me' });
    expect(out).toEqual({ field: 'assignee', op: 'has', value: ['me'] });
  });

  it('accepts an already-correct has filter with option ids', () => {
    const out = mapFilterValues(detail, { field: 'priority', op: 'has', value: ['opt-high'] });
    expect(out).toEqual({ field: 'priority', op: 'has', value: ['opt-high'] });
  });

  it('tolerates a stringified filter', () => {
    const out = mapFilterValues(detail, '{"field":"priority","op":"eq","value":"Urgent"}');
    expect(out).toEqual({ field: 'priority', op: 'has', value: ['opt-urgent'] });
  });

  it('leaves non-membership fields untouched', () => {
    const out = mapFilterValues(detail, { field: 'title', op: 'contains', value: 'spec' });
    expect(out).toEqual({ field: 'title', op: 'contains', value: 'spec' });
  });

  it('throws a helpful error naming valid options on an unknown label', () => {
    expect(() => mapFilterValues(detail, { field: 'priority', op: 'eq', value: 'Nope' })).toThrow(
      /No option "Nope".*Urgent, High/,
    );
  });
});

describe('OPS_BY_FIELD_TYPE / FILTER_GUIDE op enum has zero drift from the API contract (#204)', () => {
  it('every op advertised for every field type is a real op the REST filter AST accepts', () => {
    const valid = new Set(filterOpSchema.options);
    for (const [type, ops] of Object.entries(OPS_BY_FIELD_TYPE)) {
      for (const op of ops) {
        expect(valid.has(op), `${type} advertises unknown op "${op}"`).toBe(true);
      }
    }
  });

  it('does not advertise the never-real "starts_with" op (the root cause of #204)', () => {
    expect(FILTER_GUIDE).not.toContain('starts_with');
  });

  it('documents both the grouped and bare filter shapes with a working example', () => {
    expect(FILTER_GUIDE).toMatch(/"and":\s*\[\{\s*"field":\s*"priority",\s*"op":\s*"eq",\s*"value":\s*"Urgent"/);
    expect(FILTER_GUIDE).toMatch(/\{\s*"field":\s*"priority",\s*"op":\s*"eq",\s*"value":\s*"Urgent"\s*\}/);
    // Every example filter literally embedded in the guide must itself validate
    // against the real REST schema — the doc can never show a filter that 422s.
    expect(queryRecordsSchema.safeParse({ filter: { and: [{ field: 'priority', op: 'eq', value: 'Urgent' } as never] } }).success).toBe(true);
    expect(queryRecordsSchema.safeParse({ filter: { field: 'priority', op: 'eq', value: 'Urgent' } as never } as never).success).toBe(true);
  });
});

/**
 * End-to-end (within the process — no network/DB): drives the real query_records
 * tool handler exactly as registerTools wires it up, through a fake API client
 * whose /records/query stub (a) parses the request body with the SAME
 * queryRecordsSchema the real REST controller uses (records.controller.ts), so a
 * shape that would 422 in production fails this test too, and (b) actually
 * narrows a fixture record set by the parsed filter, proving the end result is
 * the correctly filtered subset — not just a schema-shaped no-op.
 */
describe('query_records end-to-end filter narrowing (#204)', () => {
  const priorityField = {
    apiName: 'priority',
    displayName: 'Priority',
    type: 'select',
    options: [
      { id: 'opt-urgent', label: 'Urgent' },
      { id: 'opt-high', label: 'High' },
    ],
  };
  const dbDetail = {
    id: 'db-1',
    name: 'Issues',
    qualifiedSlug: 'eng/issues',
    fields: [priorityField, { apiName: 'title', displayName: 'Title', type: 'title' }],
  };
  const allRecords = [
    { id: 'rec-1', number: 1, title: 'Fix login bug', values: { priority: 'opt-urgent' } },
    { id: 'rec-2', number: 2, title: 'Improve docs', values: { priority: 'opt-high' } },
    { id: 'rec-3', number: 3, title: 'Another urgent one', values: { priority: 'opt-urgent' } },
  ];

  // A minimal stand-in for query-compiler.ts's compileFilter/compileCondition —
  // just enough (and/or recursion, has/has_none/eq/neq over a scalar id) to prove
  // narrowing, not to re-implement the whole compiler.
  function evalNode(node: never, record: (typeof allRecords)[number]): boolean {
    const n = node as { and?: unknown[]; or?: unknown[]; field?: string; op?: string; value?: unknown };
    if (n.and) return (n.and as never[]).every((c) => evalNode(c, record));
    if (n.or) return (n.or as never[]).some((c) => evalNode(c, record));
    const v = (record.values as Record<string, unknown>)[n.field!];
    const values = Array.isArray(n.value) ? n.value : [n.value];
    if (n.op === 'has') return values.includes(v);
    if (n.op === 'has_none') return !values.includes(v);
    if (n.op === 'eq') return v === n.value;
    if (n.op === 'neq') return v !== n.value;
    throw new Error(`test stub does not model op "${n.op}"`);
  }

  function makeCtx(): Ctx {
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
        throw new Error(`unexpected GET ${path}`);
      },
      POST: async (path: string, opts: { body: unknown }) => {
        if (path !== '/api/v1/workspaces/{ws}/databases/{db}/records/query') {
          throw new Error(`unexpected POST ${path}`);
        }
        // Same zod schema the real Nest controller validates the body with
        // (apps/api/src/records/records.controller.ts's QueryRecordsDto) — a
        // filter shape the MCP would 422 on in production throws here too.
        const body = queryRecordsSchema.parse(opts.body);
        const data = body.filter ? allRecords.filter((r) => evalNode(body.filter as never, r)) : allRecords;
        return { data: { data, next_cursor: null, has_more: false } };
      },
    };
    return { client: client as never, baseUrl: 'http://test', token: 'tok' };
  }

  function makeFakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        handlers.set(name, handler as never);
      },
    };
    return { server: server as never, handlers };
  }

  async function callQueryRecords(filter: unknown) {
    const { server, handlers } = makeFakeServer();
    registerTools(server, makeCtx());
    const handler = handlers.get('query_records')!;
    const result = await handler({ workspace: 'Eng', database: 'Issues', filter });
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text) as { records: Array<{ id: string; title: string }> };
  }

  it('narrows to the matching subset for a grouped { and: [...] } filter', async () => {
    const out = await callQueryRecords({ and: [{ field: 'priority', op: 'eq', value: 'Urgent' }] });
    expect(out.records.map((r) => r.id).sort()).toEqual(['rec-1', 'rec-3']);
  });

  it('accepts a bare single condition with no and/or wrapper — no silent 422', async () => {
    const out = await callQueryRecords({ field: 'priority', op: 'eq', value: 'Urgent' });
    expect(out.records.map((r) => r.id).sort()).toEqual(['rec-1', 'rec-3']);
  });

  it('returns every record when no filter is given', async () => {
    const out = await callQueryRecords(undefined);
    expect(out.records.map((r) => r.id).sort()).toEqual(['rec-1', 'rec-2', 'rec-3']);
  });
});

describe('buildIconCatalog (list_icon_set, #251)', () => {
  const catalog = buildIconCatalog();

  it('advertises the set: prefix', () => {
    expect(catalog.prefix).toBe('set:');
  });

  it('groups every curated icon name under at least one category', () => {
    const allNames = Object.values(catalog.categories).flat();
    // Every name returned resolves back through the real set — no drift
    // between the catalog listing and what the icon param actually accepts.
    for (const name of allNames) {
      expect(setIconName(`set:${name}`)).toBe(name);
    }
    expect(allNames).toContain('rocket');
    expect(allNames).toContain('handshake');
  });

  it('has no empty categories', () => {
    for (const [label, names] of Object.entries(catalog.categories)) {
      expect(names.length, `category "${label}" is empty`).toBeGreaterThan(0);
    }
  });
});

describe('icon param description (create_database/update_database/create_space, #251)', () => {
  it('advertises set: refs and points at list_icon_set', () => {
    expect(ICON_PARAM_DESCRIPTION).toContain('set:');
    expect(ICON_PARAM_DESCRIPTION).toContain('list_icon_set');
  });

  it('mentions emoji only as legacy-tolerated, not as the preferred form', () => {
    expect(ICON_PARAM_DESCRIPTION).toMatch(/emoji/i);
    expect(ICON_PARAM_DESCRIPTION).toMatch(/backward compat|legacy|not.*preferred/i);
  });
});

// ============ #268: record url field + get_links ============
//
// registerTools() only needs `client` (the openapi-fetch-shaped surface) to
// actually be a client — so a tiny fake standing in for the API, plus a fake
// McpServer that just records the handlers it's given, exercises the real
// tool handlers end to end (workspace/database resolution, labelize, the new
// url field) without a database or network call.

interface FakeRow {
  id: string;
  number: number | null;
  title: string;
  values: Record<string, unknown>;
}

function buildFakeClient() {
  const workspaces = [{ id: 'ws-uuid-1', name: 'Acme Co', slug: 'acme' }];
  const databases = [{ id: 'db-uuid-1', name: 'Issues', apiSlug: 'issues', spaceSlug: 'ops', qualifiedSlug: 'ops/issues' }];
  const detail = {
    id: 'db-uuid-1',
    name: 'Issues',
    spaceSlug: 'ops',
    qualifiedSlug: 'ops/issues',
    fields: [] as unknown[],
    views: [{ id: 'view-uuid-1', name: 'Board', type: 'board' }],
  };
  const records = new Map<string, FakeRow>();
  records.set('rec-uuid-1', { id: 'rec-uuid-1', number: 42, title: 'Fix the bug', values: {} });
  let nextSeq = 2;
  let nextNumber = 43;

  type Path = Record<string, string> | undefined;
  const byNumber = (n: string) => [...records.values()].find((r) => String(r.number) === n);

  const GET = async (path: string, opts?: { params?: { path?: Path } }) => {
    const p = opts?.params?.path ?? {};
    if (path === '/api/v1/workspaces') return { data: workspaces };
    if (path === '/api/v1/workspaces/{ws}/databases') return { data: databases };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: detail };
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}') {
      const row = byNumber(p.number!);
      return row ? { data: row } : { error: { error: { message: `No record #${p.number}` } } };
    }
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}') {
      const row = records.get(p.rec!);
      return row ? { data: row } : { error: { error: { message: `No record ${p.rec}` } } };
    }
    throw new Error(`fake client: unhandled GET ${path}`);
  };

  const POST = async (path: string, opts?: { params?: { path?: Path }; body?: { values?: Record<string, unknown> } }) => {
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/query') {
      return { data: { data: [...records.values()], next_cursor: null, has_more: false } };
    }
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records') {
      const id = `rec-uuid-${nextSeq++}`;
      const number = nextNumber++;
      const values = opts?.body?.values ?? {};
      const row: FakeRow = { id, number, title: (values.name as string) ?? 'Untitled', values };
      records.set(id, row);
      return { data: row };
    }
    throw new Error(`fake client: unhandled POST ${path}`);
  };

  const PATCH = async (path: string, opts?: { params?: { path?: Path }; body?: { values?: Record<string, unknown> } }) => {
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}') {
      const rec = opts!.params!.path!.rec!;
      const row = records.get(rec)!;
      const updated: FakeRow = { ...row, values: { ...row.values, ...(opts?.body?.values ?? {}) } };
      records.set(rec, updated);
      return { data: updated };
    }
    throw new Error(`fake client: unhandled PATCH ${path}`);
  };

  return { GET, POST, PATCH };
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: unknown) => Promise<ToolResult>;

function buildHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const ctx = { client: buildFakeClient(), baseUrl: '', token: '' } as never;
  registerTools(fakeServer, ctx, { scope: 'admin', allowRunButton: true });
  return handlers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed JSON shape varies per tool; callers assert on the fields they check.
async function callTool(handlers: Map<string, ToolHandler>, name: string, args: unknown): Promise<any> {
  const result = await handlers.get(name)!(args);
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text);
}

const ORIGINAL_WEB_URL = process.env.WEB_URL;
const TEST_WEB_URL = 'https://test.storyos.dev';

beforeEach(() => {
  process.env.WEB_URL = TEST_WEB_URL;
});

afterEach(() => {
  if (ORIGINAL_WEB_URL === undefined) delete process.env.WEB_URL;
  else process.env.WEB_URL = ORIGINAL_WEB_URL;
});

describe('record url field (#268): get_record / query_records / create_record / update_record', () => {
  it('get_record includes a url, addressable by public number', async () => {
    const record = await callTool(buildHandlers(), 'get_record', { workspace: 'Acme Co', database: 'Issues', record: '42' });
    expect(record.url).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/fix-the-bug-42`);
  });

  it('get_record returns the identical url when the same record is addressed by uuid', async () => {
    const record = await callTool(buildHandlers(), 'get_record', { workspace: 'Acme Co', database: 'Issues', record: 'rec-uuid-1' });
    expect(record.url).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/fix-the-bug-42`);
  });

  it('query_records includes a url on every returned record', async () => {
    const result = await callTool(buildHandlers(), 'query_records', { workspace: 'Acme Co', database: 'Issues' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].url).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/fix-the-bug-42`);
  });

  it('create_record returns a url built from the newly created record', async () => {
    const result = await callTool(buildHandlers(), 'create_record', {
      workspace: 'Acme Co',
      database: 'Issues',
      values: { name: 'Ship it' },
    });
    const record = result.record ?? result; // unwrap the unset_fields envelope if present
    expect(record.url).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/ship-it-43`);
  });

  it('update_record returns a url reflecting the updated record, addressed by number', async () => {
    const record = await callTool(buildHandlers(), 'update_record', {
      workspace: 'Acme Co',
      database: 'Issues',
      record: '42',
      values: {},
    });
    expect(record.url).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/fix-the-bug-42`);
  });

  it('update_record returns the same url when addressed by uuid instead', async () => {
    const record = await callTool(buildHandlers(), 'update_record', {
      workspace: 'Acme Co',
      database: 'Issues',
      record: 'rec-uuid-1',
      values: {},
    });
    expect(record.url).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/fix-the-bug-42`);
  });
});

describe('get_links (#268)', () => {
  it('resolves the database link on its own', async () => {
    const result = await callTool(buildHandlers(), 'get_links', { workspace: 'Acme Co', database: 'Issues' });
    expect(result.database).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1`);
  });

  it('resolves a batch of record links, keyed by the ref passed in, for both number and uuid refs', async () => {
    const result = await callTool(buildHandlers(), 'get_links', {
      workspace: 'Acme Co',
      database: 'Issues',
      records: ['42', 'rec-uuid-1'],
    });
    expect(result.records['42']).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/fix-the-bug-42`);
    expect(result.records['rec-uuid-1']).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/fix-the-bug-42`);
  });

  it('resolves a named view link', async () => {
    const result = await callTool(buildHandlers(), 'get_links', { workspace: 'Acme Co', database: 'Issues', views: ['Board'] });
    expect(result.views.Board).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1?view=view-uuid-1`);
  });

  it('errors when records/views are requested without a database', async () => {
    const handlers = buildHandlers();
    const result = await handlers.get('get_links')!({ workspace: 'Acme Co', records: ['42'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/database.*required/i);
  });
});

/**
 * create_view regression (#270): the ticket reported "No approval received" on
 * every create_view call, for both board and form types, while every sibling
 * write tool (create_database, add_field, create_record, create_relation,
 * update_record) succeeded in the same session. No approval/consent gate of any
 * kind exists in this file or in apps/api for MCP write tools — the only
 * "approval" concept in the codebase gates autonomous Agent Run actions (#210),
 * an unrelated domain never wired to view/database/field mutations. These tests
 * drive the REAL registerTools()-produced create_view/update_view handlers
 * (not just the pure helpers above) against a fake StoryOS API client, proving
 * table/board/form all succeed end-to-end through this exact code path.
 */
describe('create_view / update_view (#270)', () => {
  const WORKSPACE = { id: 'ws-1', name: 'JCM Agency' };
  const DATABASE = {
    id: 'db-1',
    name: 'Leads',
    apiSlug: 'leads_2',
    fields: [
      { id: 'f-stage', apiName: 'pipeline_stage', displayName: 'Pipeline stage', type: 'select', options: [{ id: 'opt-new', label: 'New' }] },
      { id: 'f-name', apiName: 'name', displayName: 'Name', type: 'text' },
      { id: 'f-email', apiName: 'email', displayName: 'Email', type: 'email' },
    ],
    views: [
      { id: 'view-existing', name: 'All records', type: 'table' },
      { id: 'view-form', name: 'Signup Form', type: 'form' },
    ],
  };

  /** Fake McpServer: captures each registered tool's handler by name. */
  function fakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    return {
      server: { registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<unknown>) => handlers.set(name, handler) },
      handlers,
    };
  }

  /** Fake openapi-fetch client covering exactly what create_view/update_view touch. */
  function fakeClient() {
    const posted: Array<{ path: string; body: unknown }> = [];
    const patched: Array<{ path: string; body: unknown }> = [];
    const GET = async (path: string) => {
      if (path === '/api/v1/workspaces') return { data: [WORKSPACE] };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: [DATABASE] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: DATABASE };
      throw new Error(`unmocked GET ${path}`);
    };
    const POST = async (path: string, opts: { body?: unknown }) => {
      posted.push({ path, body: opts.body });
      return { data: { id: 'view-new', name: (opts.body as { name: string }).name, type: (opts.body as { type: string }).type, config: (opts.body as { config: unknown }).config } };
    };
    const PATCH = async (path: string, opts: { body?: unknown }) => {
      patched.push({ path, body: opts.body });
      return { data: { id: 'view-existing', ...(opts.body as Record<string, unknown>) } };
    };
    return { client: { GET, POST, PATCH, DELETE: POST } as never, posted, patched };
  }

  function registerAndGet(names: string[]) {
    const { server, handlers } = fakeServer();
    const { client, posted, patched } = fakeClient();
    registerTools(server as never, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
    return { handlers: Object.fromEntries(names.map((n) => [n, handlers.get(n)!])), posted, patched };
  }

  it('creates a table view with standard params', async () => {
    const { handlers } = registerAndGet(['create_view']);
    const res = (await handlers.create_view!({ workspace: 'JCM Agency', database: 'leads_2', name: 'All records', type: 'table' })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('"type": "table"');
  });

  it('creates a board view grouped by a select field, per the ticket\'s blocked scenario', async () => {
    const { handlers, posted } = registerAndGet(['create_view']);
    const res = (await handlers.create_view!({
      workspace: 'JCM Agency',
      database: 'leads_2',
      name: 'Pipeline Board',
      type: 'board',
      group_by: 'pipeline_stage',
      card_fields: ['name'],
    })) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    const body = posted[0]!.body as { config: { group_by_field_id: string; card_field_ids: string[] } };
    expect(body.config.group_by_field_id).toBe('f-stage');
    expect(body.config.card_field_ids).toEqual(['f-name']);
  });

  it('creates a board view with no optional params (still succeeds as a tool call — board-specific config validation is the API\'s job, not a blanket failure)', async () => {
    const { handlers } = registerAndGet(['create_view']);
    const res = (await handlers.create_view!({ workspace: 'JCM Agency', database: 'leads_2', name: 'Bare board', type: 'board' })) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
  });

  it('creates a members-only form view with no form_* params (no token, no error)', async () => {
    const { handlers, posted } = registerAndGet(['create_view']);
    const res = (await handlers.create_view!({ workspace: 'JCM Agency', database: 'leads_2', name: 'Signup Form', type: 'form' })) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    const form = (posted[0]!.body as { config: { form: Record<string, unknown> } }).config.form;
    expect(form.access).toBe('members');
    expect(form).not.toHaveProperty('public_token');
  });

  it('builds a fully-configured public signup form — the ticket\'s second blocked view', async () => {
    const { handlers, posted } = registerAndGet(['create_view']);
    const res = (await handlers.create_view!({
      workspace: 'JCM Agency',
      database: 'leads_2',
      name: 'Signup Form',
      type: 'form',
      form_title: 'Join our list',
      form_access: 'public',
      form_fields: ['name', { field: 'email', required: true, label: 'Work email' }],
      form_success_message: 'Thanks — we will be in touch.',
    })) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    const form = (posted[0]!.body as { config: { form: Record<string, unknown> } }).config.form as {
      title: string;
      access: string;
      public_token: string;
      fields: Array<{ field_id: string; required?: boolean; label?: string }>;
      success_message: string;
    };
    expect(form.title).toBe('Join our list');
    expect(form.access).toBe('public');
    expect(typeof form.public_token).toBe('string');
    expect(form.public_token.length).toBeGreaterThan(0);
    expect(form.fields).toEqual([{ field_id: 'f-name' }, { field_id: 'f-email', required: true, label: 'Work email' }]);
    expect(form.success_message).toBe('Thanks — we will be in touch.');
  });

  it('rejects an unknown form field by name with a helpful error, not a bare failure', async () => {
    const { handlers } = registerAndGet(['create_view']);
    const res = (await handlers.create_view!({
      workspace: 'JCM Agency',
      database: 'leads_2',
      name: 'Signup Form',
      type: 'form',
      form_fields: ['not_a_real_field'],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/No field matches "not_a_real_field"/);
  });

  it('update_view rebuilds the form config and issues a fresh public_token when form_access is re-specified', async () => {
    const { handlers, patched } = registerAndGet(['update_view']);
    const res = (await handlers.update_view!({
      workspace: 'JCM Agency',
      database: 'leads_2',
      view: 'Signup Form',
      form_access: 'link',
    })) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    const form = (patched[0]!.body as { config: { form: Record<string, unknown> } }).config.form as { access: string; public_token: string };
    expect(form.access).toBe('link');
    expect(typeof form.public_token).toBe('string');
  });

  it('update_view leaves config untouched when only renaming', async () => {
    const { handlers, patched } = registerAndGet(['update_view']);
    await handlers.update_view!({ workspace: 'JCM Agency', database: 'leads_2', view: 'All records', rename_to: 'Renamed' });
    expect(patched[0]!.body).toEqual({ name: 'Renamed' });
  });
});
