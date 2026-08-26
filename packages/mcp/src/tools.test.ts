import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { brandIconSlug, setIconName } from '@storyos/schemas/icons';
import { filterOpSchema, queryRecordsSchema } from '@storyos/schemas';
import { buildIconCatalog, coerceStringified, coerceInputSchema, FILTER_GUIDE, ICON_PARAM_DESCRIPTION, mapFilterValues, OPS_BY_FIELD_TYPE, registerTools } from './tools.js';
import { z } from 'zod';
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
    // #172: the canonical status field is a `workflow` (single-select-shaped).
    {
      apiName: 'state',
      type: 'workflow',
      options: [
        { id: 'opt-backlog', label: 'Backlog' },
        { id: 'opt-done', label: 'Done' },
      ],
    },
    { apiName: 'assignee', type: 'user' },
    { apiName: 'created_by', type: 'created_by', isSystem: true },
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

  it('resolves a WORKFLOW field label like a select (regression: state 422 "unknown option id")', () => {
    // The canonical status field is `workflow`, not `select`; it was omitted from
    // the choice-field handling, so its labels never resolved to option ids.
    const out = mapFilterValues(detail, { field: 'state', op: 'eq', value: 'Backlog' });
    expect(out).toEqual({ field: 'state', op: 'has', value: ['opt-backlog'] });
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

  // #354: system person fields are scalar (eq/neq stay eq/neq — NOT mapped to has),
  // but the @me sentinel still translates to the server's "me".
  it('maps @me on created_by without converting eq → has', () => {
    const out = mapFilterValues(detail, { field: 'created_by', op: 'eq', value: '@me' });
    expect(out).toEqual({ field: 'created_by', op: 'eq', value: 'me' });
  });

  it('maps @me on updated_by even though it has no stored field row (registry-driven)', () => {
    const out = mapFilterValues(detail, { field: 'updated_by', op: 'neq', value: '@me' });
    expect(out).toEqual({ field: 'updated_by', op: 'neq', value: 'me' });
  });

  it('passes number/created_at system-field conditions straight through', () => {
    expect(mapFilterValues(detail, { field: 'number', op: 'gte', value: 320 })).toEqual({
      field: 'number',
      op: 'gte',
      value: 320,
    });
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

describe('buildIconCatalog brand set (list_icon_set, #298)', () => {
  const catalog = buildIconCatalog();

  it('advertises the brand: prefix', () => {
    expect(catalog.brands.prefix).toBe('brand:');
  });

  it('includes real, recognizable platform marks plus the two StoryOS-sibling products', () => {
    const slugs = catalog.brands.icons.map((d) => d.slug);
    expect(slugs).toContain('github');
    expect(slugs).toContain('notion');
    expect(slugs).toContain('figma');
    expect(slugs).toContain('storyfunnels');
    expect(slugs).toContain('storypages');
  });

  it('has ~100 third-party marks plus the 2 custom ones', () => {
    expect(catalog.brands.icons.length).toBeGreaterThanOrEqual(100);
  });

  it('every listed slug resolves back through brandIconSlug — no drift between the catalog and what the icon param accepts', () => {
    for (const { slug } of catalog.brands.icons) {
      expect(brandIconSlug(`brand:${slug}`)).toBe(slug);
    }
  });

  it('every brand entry has a name and non-empty keywords', () => {
    for (const d of catalog.brands.icons) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.keywords.length).toBeGreaterThan(0);
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
    views: [
      { id: 'view-uuid-1', name: 'Board', type: 'board' },
      {
        id: 'view-uuid-2',
        name: 'My Epic',
        type: 'table',
        config: { filter: { field: 'state', op: 'eq', value: 'ToDo' }, sorts: [{ field: 'number', dir: 'asc' }] },
      },
    ],
  };
  const records = new Map<string, FakeRow>();
  records.set('rec-uuid-1', { id: 'rec-uuid-1', number: 42, title: 'Fix the bug', values: {} });
  let nextSeq = 2;
  let nextNumber = 43;
  const documents = new Map<string, { content: unknown; version: number; updated_at: string | null }>();

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
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document') {
      const doc = documents.get(p.rec!);
      return { data: doc ? { record_id: p.rec, ...doc } : { record_id: p.rec, content: null, version: 0, updated_at: null } };
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

  const PUT = async (
    path: string,
    opts?: { params?: { path?: Path }; body?: { content?: unknown; expected_version?: number } },
  ) => {
    if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document') {
      const rec = opts!.params!.path!.rec!;
      const existing = documents.get(rec);
      const currentVersion = existing?.version ?? 0;
      const expected = opts?.body?.expected_version;
      if (expected !== currentVersion) {
        return {
          error: {
            error: {
              message: 'Document was edited elsewhere',
              details: [{ path: 'expected_version', message: `current version is ${currentVersion}` }],
            },
          },
        };
      }
      const updated = { content: opts?.body?.content, version: currentVersion + 1, updated_at: '2026-01-01T00:00:00.000Z' };
      documents.set(rec, updated);
      return { data: { record_id: rec, ...updated } };
    }
    throw new Error(`fake client: unhandled PUT ${path}`);
  };

  return { GET, POST, PATCH, PUT };
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

  it('describe_database returns each view id, and the filter/sorts when it has them (#332)', async () => {
    const out = (await callTool(buildHandlers(), 'describe_database', {
      workspace: 'Acme Co',
      database: 'Issues',
    })) as {
      views: Array<{ id: string; name: string; type: string; filter?: unknown; sorts?: unknown }>;
    };

    // The id is the whole point: a `?view=<uuid>` link is unresolvable without it.
    const board = out.views.find((v) => v.name === 'Board')!;
    expect(board.id).toBe('view-uuid-1');

    // A filtered view reports WHAT it selects, in the same AST query_records takes.
    const epic = out.views.find((v) => v.name === 'My Epic')!;
    expect(epic.id).toBe('view-uuid-2');
    expect(epic.filter).toEqual({ field: 'state', op: 'eq', value: 'ToDo' });
    expect(epic.sorts).toEqual([{ field: 'number', dir: 'asc' }]);

    // A view with no filter doesn't carry empty keys — noise in every response.
    expect('filter' in board).toBe(false);
    expect('sorts' in board).toBe(false);
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

describe('get_record_description / update_record_description (#280)', () => {
  it('reads version 0 and empty content for a record that has never had a description written', async () => {
    const result = await callTool(buildHandlers(), 'get_record_description', {
      workspace: 'Acme Co',
      database: 'Issues',
      record: '42',
    });
    expect(result).toEqual({ content: '', version: 0, updated_at: null });
  });

  it('writes Markdown, and a follow-up read reflects it', async () => {
    const handlers = buildHandlers();
    const written = await callTool(handlers, 'update_record_description', {
      workspace: 'Acme Co',
      database: 'Issues',
      record: '42',
      content: '# Heading\n\nSome body text.',
    });
    expect(written.version).toBe(1);

    const read = await callTool(handlers, 'get_record_description', { workspace: 'Acme Co', database: 'Issues', record: '42' });
    expect(read.version).toBe(1);
    expect(read.content).toContain('Heading');
    expect(read.content).toContain('Some body text.');
  });

  it('omitting expected_version auto-fetches the current one, so a second write in a row still succeeds', async () => {
    const handlers = buildHandlers();
    await callTool(handlers, 'update_record_description', { workspace: 'Acme Co', database: 'Issues', record: '42', content: 'First.' });
    const second = await callTool(handlers, 'update_record_description', { workspace: 'Acme Co', database: 'Issues', record: '42', content: 'Second.' });
    expect(second.version).toBe(2);
  });

  it('a stale expected_version surfaces the conflict clearly instead of silently overwriting', async () => {
    const handlers = buildHandlers();
    await callTool(handlers, 'update_record_description', { workspace: 'Acme Co', database: 'Issues', record: '42', content: 'First.' });

    const result = await handlers.get('update_record_description')!({
      workspace: 'Acme Co',
      database: 'Issues',
      record: '42',
      content: 'Conflicting write.',
      expected_version: 0, // stale — the record is already at version 1
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/edited elsewhere/i);
    expect(result.content[0]!.text).toMatch(/current version is 1/i);
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
      {
        id: 'view-existing',
        name: 'All records',
        type: 'table',
        // #191: the detail endpoint returns each view's cleaned config; update_view
        // merges onto it, so these must survive a filter-only edit.
        config: { sorts: [{ field: 'name', direction: 'asc' }], hidden_field_ids: ['f-email'] },
      },
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

  it('update_view with ONLY filters builds a non-empty config patch — no 500 (#191)', async () => {
    // The bug: `filters`/`sorts` were absent from CONFIG_KEYS, so a filter-only
    // update never built config → patch was `{}` → the service did a Drizzle
    // .set() with all-undefined → "no values to set" → 500.
    const { handlers, patched } = registerAndGet(['update_view']);
    const res = (await handlers.update_view!({
      workspace: 'JCM Agency',
      database: 'leads_2',
      view: 'All records',
      filters: { and: [{ field: 'pipeline_stage', op: 'eq', value: 'New' }] },
    })) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    const body = patched[0]!.body as { name?: string; config?: Record<string, unknown> };
    expect(body.config).toBeDefined();
    expect(body.config!.filters).toBeDefined();
    // the select label 'New' resolved to its option id, same as create_view
    // (an eq on a select is translated to an id-array op, #354).
    expect(JSON.stringify(body.config!.filters)).toContain('opt-new');
  });

  it('update_view merges the change onto existing config — a filter edit keeps sorts + hidden fields (#191)', async () => {
    const { handlers, patched } = registerAndGet(['update_view']);
    await handlers.update_view!({
      workspace: 'JCM Agency',
      database: 'leads_2',
      view: 'All records',
      filters: { and: [{ field: 'pipeline_stage', op: 'eq', value: 'New' }] },
    });
    const config = (patched[0]!.body as { config: Record<string, unknown> }).config;
    // pre-existing settings survive the patch (not wiped to defaults)
    expect(config.sorts).toEqual([{ field: 'name', direction: 'asc' }]);
    expect(config.hidden_field_ids).toEqual(['f-email']);
    expect(config.filters).toBeDefined();
  });
});

/**
 * list_skills / run_skill (#41): both ride the real GET/POST the in-app Skills UI
 * uses (SkillsController), so these tests drive the registerTools()-produced
 * handlers against a fake client stubbing exactly those two routes — proving the
 * tools resolve a skill by name (not just id), never reimplement visibility
 * (the fake simply returns whatever the "server" would already have filtered),
 * and echo `inputs` back rather than posting them anywhere (there is nowhere on
 * the real endpoint for them to go yet).
 */
describe('list_skills / run_skill (#41)', () => {
  const WORKSPACE = { id: 'ws-1', name: 'JCM Agency' };
  const SKILLS = [
    {
      id: 'skill-1',
      name: 'Weekly Status Digest',
      description: 'Summarizes the week.',
      when_to_use: 'Every Friday.',
      instructions: 'List records changed this week.',
      examples: [],
      allowed_tools: ['records.read'],
      visibility: 'shared',
      editable: false,
      source_template: 'weekly-digest',
    },
    {
      id: 'skill-2',
      name: 'Lead Triage Reply',
      description: 'Drafts a first-touch reply.',
      when_to_use: 'A new lead lands.',
      instructions: 'Draft a friendly reply.',
      examples: [],
      allowed_tools: [],
      visibility: 'personal',
      editable: true,
      source_template: null,
    },
  ];

  function fakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
    return {
      server: { registerTool: (name: string, _c: unknown, handler: (args: unknown) => Promise<ToolResult>) => handlers.set(name, handler) } as unknown as McpServer,
      handlers,
    };
  }

  function fakeClient() {
    const posted: Array<{ path: string; params?: unknown }> = [];
    const GET = async (path: string) => {
      if (path === '/api/v1/workspaces') return { data: [WORKSPACE] };
      // SkillsController_list's real JSON body is `{ data: [...] }` (SkillsService.list),
      // so the fake client's own `{data, error}` envelope wraps that body directly:
      // one extra level vs. e.g. list_databases, whose endpoint returns a bare array.
      if (path === '/api/v1/workspaces/{ws}/skills') return { data: { data: SKILLS } };
      throw new Error(`unmocked GET ${path}`);
    };
    const POST = async (path: string, opts: { params?: { path?: { id?: string } } }) => {
      posted.push({ path, params: opts.params });
      if (path === '/api/v1/workspaces/{ws}/skills/{id}/run') {
        return { data: { run_class: 'non_ai', steps: [{ tool: 'principal.resolve', summary: 'ok' }], ran_at: '2026-01-01T00:00:00.000Z' } };
      }
      throw new Error(`unmocked POST ${path}`);
    };
    return { client: { GET, POST } as never, posted };
  }

  function registerAndGet() {
    const { server, handlers } = fakeServer();
    const { client, posted } = fakeClient();
    registerTools(server, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
    return { handlers, posted };
  }

  it('list_skills returns every skill the fake client hands back, personal and shared alike', async () => {
    const { handlers } = registerAndGet();
    const res = await callTool(handlers, 'list_skills', { workspace: 'JCM Agency' });
    expect(res).toHaveLength(2);
    expect(res.map((s: { name: string }) => s.name)).toEqual(['Weekly Status Digest', 'Lead Triage Reply']);
    expect(res[0].allowed_tools).toEqual(['records.read']);
  });

  it('run_skill resolves a skill by name (not just id), posts the run, and echoes instructions + inputs back', async () => {
    const { handlers, posted } = registerAndGet();
    const res = await callTool(handlers, 'run_skill', {
      workspace: 'JCM Agency',
      name: 'Weekly Status Digest',
      inputs: { database: 'Tasks' },
    });
    expect(posted).toEqual([{ path: '/api/v1/workspaces/{ws}/skills/{id}/run', params: { path: { ws: 'ws-1', id: 'skill-1' } } }]);
    expect(res.skill.id).toBe('skill-1');
    expect(res.instructions).toBe('List records changed this week.');
    expect(res.inputs).toEqual({ database: 'Tasks' });
    expect(res.run_log.run_class).toBe('non_ai');
  });

  it('run_skill also resolves by id', async () => {
    const { handlers } = registerAndGet();
    const res = await callTool(handlers, 'run_skill', { workspace: 'JCM Agency', name: 'skill-2' });
    expect(res.skill.name).toBe('Lead Triage Reply');
    expect(res.inputs).toEqual({});
  });

  it('run_skill surfaces a helpful error for an unknown name instead of a bare failure', async () => {
    const { handlers } = registerAndGet();
    const result = await handlers.get('run_skill')!({ workspace: 'JCM Agency', name: 'Nonexistent Skill' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No skill matches "Nonexistent Skill"/);
  });

  it('a read-scoped token sees list_skills but not run_skill (MN-134 parity)', async () => {
    const { server, handlers } = fakeServer();
    const { client } = fakeClient();
    registerTools(server, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'read', allowRunButton: true });
    expect(handlers.has('list_skills')).toBe(true);
    expect(handlers.has('run_skill')).toBe(false);
  });
});

/**
 * get_runs (MN-264): rides the real GET the in-app Runs page uses
 * (RunsController.list), so this proves the tool resolves the workspace,
 * forwards status/limit as query params, and hands the envelope straight
 * back — no reshaping, since the API's own shape is already agent-friendly.
 */
describe('get_runs (MN-264)', () => {
  const WORKSPACE = { id: 'ws-1', name: 'JCM Agency' };
  const RUNS_ENVELOPE = {
    data: [
      { id: 'run-1', kind: 'rule', name: 'Escalate urgent', status: 'ok', action_summary: [] },
      { id: 'run-2', kind: 'rule', name: 'Escalate urgent', status: 'skipped_quota', action_summary: [] },
    ],
    next_cursor: null,
    has_more: false,
  };

  function fakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
    return {
      server: {
        registerTool: (name: string, _c: unknown, handler: (args: unknown) => Promise<ToolResult>) =>
          handlers.set(name, handler),
      } as unknown as McpServer,
      handlers,
    };
  }

  function fakeClient() {
    const gets: Array<{ path: string; params?: unknown }> = [];
    const GET = async (path: string, opts: { params?: unknown } = {}) => {
      gets.push({ path, params: opts.params });
      if (path === '/api/v1/workspaces') return { data: [WORKSPACE] };
      if (path === '/api/v1/workspaces/{ws}/runs') return { data: RUNS_ENVELOPE };
      throw new Error(`unmocked GET ${path}`);
    };
    return { client: { GET } as never, gets };
  }

  it('resolves the workspace and returns the envelope untouched', async () => {
    const { server, handlers } = fakeServer();
    const { client, gets } = fakeClient();
    registerTools(server, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
    const res = await callTool(handlers, 'get_runs', { workspace: 'JCM Agency' });
    expect(res).toEqual(RUNS_ENVELOPE);
    expect(gets[1]).toEqual({
      path: '/api/v1/workspaces/{ws}/runs',
      params: { path: { ws: 'ws-1' }, query: { status: undefined, limit: undefined } },
    });
  });

  it('forwards status and limit as query params', async () => {
    const { server, handlers } = fakeServer();
    const { client, gets } = fakeClient();
    registerTools(server, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
    await callTool(handlers, 'get_runs', { workspace: 'JCM Agency', status: 'skipped_quota', limit: 10 });
    expect(gets[1]!.params).toEqual({ path: { ws: 'ws-1' }, query: { status: 'skipped_quota', limit: 10 } });
  });

  it('is read-scoped — visible to a read-only token (MN-134 parity)', () => {
    const { server, handlers } = fakeServer();
    const { client } = fakeClient();
    registerTools(server, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'read', allowRunButton: true });
    expect(handlers.has('get_runs')).toBe(true);
  });
});

/**
 * list_sources (#239): a thin read over GET .../databases/{db}/sources — this
 * proves the tool resolves workspace + database by name (not just id), the
 * same convention every other read tool follows, and simply passes the
 * service's `data` array through.
 */
describe('list_sources (#239)', () => {
  const WORKSPACE = { id: 'ws-1', name: 'JCM Agency' };
  const DATABASE = { id: 'db-1', name: 'YouTube Comments', apiSlug: 'youtube_comments', spaceSlug: 'social' };
  const SOURCES = [
    {
      id: 'src-1',
      name: 'Channel comments',
      provider_source: 'youtube.comments',
      schedule: '15m',
      status: 'active',
      last_sync_at: '2026-01-01T00:00:00.000Z',
    },
  ];

  function fakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
    return {
      server: {
        registerTool: (name: string, _c: unknown, handler: (args: unknown) => Promise<ToolResult>) => handlers.set(name, handler),
      } as unknown as McpServer,
      handlers,
    };
  }

  function fakeClient() {
    const GET = async (path: string) => {
      if (path === '/api/v1/workspaces') return { data: [WORKSPACE] };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: [DATABASE] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/sources') return { data: { data: SOURCES } };
      throw new Error(`unmocked GET ${path}`);
    };
    return { client: { GET } as never };
  }

  it('resolves workspace + database by name and returns the sources list', async () => {
    const { server, handlers } = fakeServer();
    const { client } = fakeClient();
    registerTools(server, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'admin', allowRunButton: true });
    const res = await callTool(handlers, 'list_sources', { workspace: 'JCM Agency', database: 'YouTube Comments' });
    expect(res).toEqual(SOURCES);
  });

  it('is visible to a read-scoped token (visibility only, no write tool exists for it)', async () => {
    const { server, handlers } = fakeServer();
    const { client } = fakeClient();
    registerTools(server, { client, baseUrl: 'http://x', token: 't' } as Ctx, { scope: 'read', allowRunButton: true });
    expect(handlers.has('list_sources')).toBe(true);
  });
});

describe('describe_database enumerates system fields from the registry (#354)', () => {
  const dbDetail = {
    id: 'db-1',
    name: 'Issues',
    qualifiedSlug: 'eng/issues',
    my_access: 'admin',
    // Stored rows: the title, a user field, plus the stored system rows that used
    // to be hidden (created_at) or shown ad-hoc (id). describe should present a
    // single, consistent system set from the registry — not these raw rows.
    fields: [
      { id: 'f0', apiName: 'id', displayName: 'ID', type: 'id', isSystem: true },
      { id: 'f1', apiName: 'name', displayName: 'Name', type: 'title' },
      { id: 'f2', apiName: 'priority', displayName: 'Priority', type: 'select', options: [{ id: 'o1', label: 'High' }] },
      { id: 'f3', apiName: 'created_at', displayName: 'Created at', type: 'created_at', isSystem: true },
    ],
    views: [],
  };

  function fakeServer() {
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    return {
      server: { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never,
      handlers,
    };
  }
  function makeCtx(): Ctx {
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
        throw new Error(`unexpected GET ${path}`);
      },
    };
    return { client: client as never, baseUrl: 'http://test', token: 'tok' };
  }

  async function describe() {
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx());
    const res = await handlers.get('describe_database')!({ workspace: 'Eng', database: 'Issues' });
    if (res.isError) throw new Error(res.content[0]!.text);
    return JSON.parse(res.content[0]!.text) as {
      fields: Array<{ api_name: string; type: string; read_only?: boolean; ops?: string[]; sortable?: boolean }>;
    };
  }

  it('lists ALL six system fields (previously only `id` showed), each read-only with ops', async () => {
    const { fields } = await describe();
    const byName = new Map(fields.map((f) => [f.api_name, f]));
    for (const name of ['number', 'id', 'created_at', 'updated_at', 'created_by', 'updated_by']) {
      const f = byName.get(name);
      expect(f, `system field ${name} present`).toBeTruthy();
      expect(f!.read_only).toBe(true);
      expect(Array.isArray(f!.ops) && f!.ops!.length > 0).toBe(true);
    }
    expect(byName.get('number')!.ops).toContain('gte');
    expect(byName.get('created_at')!.ops).toContain('within');
    expect(byName.get('created_by')!.ops).toContain('has');
  });

  it('keeps user/title fields and does not duplicate the stored system rows', async () => {
    const { fields } = await describe();
    const names = fields.map((f) => f.api_name);
    expect(names).toContain('name'); // title stays
    expect(names).toContain('priority'); // user field stays
    expect(names.filter((n) => n === 'id')).toHaveLength(1); // stored id row not duplicated
    expect(names.filter((n) => n === 'created_at')).toHaveLength(1);
  });
});

describe('FILTER_GUIDE documents system fields (#354)', () => {
  it('advertises number/created_at/created_by/updated_by api_names', () => {
    for (const name of ['number', 'id', 'created_at', 'updated_at', 'created_by', 'updated_by']) {
      expect(FILTER_GUIDE).toContain(name);
    }
  });
});

/**
 * #334 — the record-write params take the JSON encoding too. A client that
 * serialises one object argument serialises all of them, so fixing only the
 * automation params would have left the same client unable to write records.
 */
describe('write params accept JSON strings (#334)', () => {
  it('create_record takes values as a JSON string', async () => {
    const result = await callTool(buildHandlers(), 'create_record', {
      workspace: 'Acme Co',
      database: 'Issues',
      values: JSON.stringify({ name: 'Ship it' }),
    });
    const record = result.record ?? result;
    // Identical to the object form's assertion above — the title made it through.
    expect(record.url).toBe(`${TEST_WEB_URL}/w/ws-uuid-1/d/db-uuid-1/r/ship-it-43`);
  });
});

/**
 * #216 — option icons over MCP. An agent could set an option's COLOUR but not
 * its icon, so a workspace built through the MCP was visibly poorer than a
 * hand-built one — and describe_database showed an icon the agent had no way to
 * write back.
 *
 * Own harness (same shape as #354's above) because the shared fake client's
 * database fixture carries no fields at all.
 */
describe('option icons round-trip through the MCP (#216)', () => {
  const dbDetail = {
    id: 'db-1',
    name: 'Issues',
    qualifiedSlug: 'eng/issues',
    my_access: 'admin',
    fields: [
      { id: 'f1', apiName: 'name', displayName: 'Name', type: 'title' },
      {
        id: 'f2',
        apiName: 'priority',
        displayName: 'Priority',
        type: 'select',
        // One option with an icon and one without, so both the present and the
        // absent case are covered.
        options: [
          { id: 'o1', label: 'Urgent', color: 'red', icon: 'set:flame' },
          { id: 'o2', label: 'High', color: 'orange' },
        ],
      },
    ],
    views: [],
  };

  const written: unknown[] = [];

  function makeCtx(): Ctx {
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
        throw new Error(`unexpected GET ${path}`);
      },
      POST: async (path: string, opts?: { body?: unknown }) => {
        written.push(opts?.body);
        return { data: { id: 'f3', apiName: 'severity', displayName: 'Severity', type: 'select' } };
      },
    };
    return { client: client as never, baseUrl: 'http://test', token: 'tok' };
  }

  function handlersFor() {
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, makeCtx());
    return handlers;
  }

  it('describe_database returns an option icon, and omits the key when there is none', async () => {
    const res = await handlersFor().get('describe_database')!({ workspace: 'Eng', database: 'Issues' });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0]!.text) as {
      fields: Array<{ api_name: string; options?: Array<Record<string, unknown>> }>;
    };

    const priority = out.fields.find((f) => f.api_name === 'priority')!;
    const urgent = priority.options!.find((o) => o.label === 'Urgent')!;
    const high = priority.options!.find((o) => o.label === 'High')!;

    expect(urgent.icon).toBe('set:flame');
    expect(urgent.color).toBe('red');
    // Absent rather than null: the common no-icon case stays terse, and an agent
    // copying this object straight back does not send `icon: null` and clear one.
    expect('icon' in high).toBe(false);
  });

  it('add_field sends an option icon through to the API', async () => {
    written.length = 0;
    const res = await handlersFor().get('add_field')!({
      workspace: 'Eng',
      database: 'Issues',
      name: 'Severity',
      type: 'select',
      // A bare string still works alongside the object form — the icon is
      // additive, not a new required shape.
      options: [{ label: 'Sev1', color: 'red', icon: 'set:flame' }, 'Sev2'],
    });
    expect(res.isError).toBeFalsy();
    const body = written[0] as { options: Array<Record<string, unknown>> };
    expect(body.options[0]).toEqual({ label: 'Sev1', color: 'red', icon: 'set:flame' });
    expect(body.options[1]).toEqual({ label: 'Sev2' });
  });
});

/**
 * #337 — `workflow` is creatable over MCP.
 *
 * Asserted against the tool's INPUT SCHEMA, because the schema is what was
 * broken: `type` was a `z.enum` that simply did not list `workflow`, so the
 * call was rejected before any handler ran. (callTool bypasses zod, so driving
 * the handler would prove nothing about the enum — and the fake client has no
 * POST-fields route either.)
 *
 * Its absence meant an agent building a database could only ever give it a plain
 * `select` for status, silently creating the debt #218 exists to pay off.
 * `workflow` is the canonical status field: board grouping, the mention badge
 * and My Work all key off it.
 */
describe('add_field accepts type: workflow (#337)', () => {
  type Parsable = { safeParse: (v: unknown) => { success: boolean } };
  function fieldOf(tool: string, key: string): Parsable {
    const configs = new Map<string, { inputSchema?: Record<string, never> }>();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, never> }) => {
        configs.set(name, config);
      },
    } as unknown as McpServer;
    registerTools(fakeServer, { client: buildFakeClient(), baseUrl: '', token: '' } as never, {
      scope: 'admin',
      allowRunButton: true,
    });
    const schema = configs.get(tool)?.inputSchema as Record<string, Parsable> | undefined;
    if (!schema?.[key]) throw new Error(`${tool} has no input field "${key}"`);
    return schema[key];
  }

  it('lists workflow among the field types', () => {
    const type = fieldOf('add_field', 'type');
    expect(type.safeParse('workflow').success).toBe(true);
    // The types it always accepted, so a widening can't be a silent loosening.
    expect(type.safeParse('select').success).toBe(true);
    expect(type.safeParse('formula').success).toBe(true);
    expect(type.safeParse('not-a-type').success).toBe(false);
  });

  it('change_field_type can target workflow too', () => {
    // select → workflow is an allowed conversion server-side (fields.service
    // ALLOWED map), so the MCP must be able to name the destination.
    expect(fieldOf('change_field_type', 'new_type').safeParse('workflow').success).toBe(true);
  });
});

/**
 * #343 — every record-returning tool must hand back the SAME shape.
 *
 * The fake API below models the divergence that actually existed in production:
 * the GET hydrates relation chips, and the write endpoints (POST/PATCH/links) do
 * NOT. That asymmetry is real and is exactly what made `update_record` echo a
 * record with its `epic` missing, indistinguishable from data loss. If a future
 * refactor goes back to echoing the write response, these tests fail.
 */
describe('record tools return one consistent shape (#343)', () => {
  const dbDetail = {
    id: 'db-1',
    name: 'Issues',
    qualifiedSlug: 'eng/issues',
    fields: [
      { id: 'f-title', apiName: 'name', displayName: 'Name', type: 'title' },
      {
        id: 'f-state',
        apiName: 'state',
        displayName: 'State',
        type: 'workflow',
        options: [
          { id: 'opt-todo', label: 'ToDo' },
          { id: 'opt-done', label: 'Done' },
        ],
      },
      { id: 'f-details', apiName: 'details', displayName: 'Details', type: 'rich_text' },
      { id: 'f-epic', apiName: 'epic', displayName: 'Epic', type: 'relation', relation: { target_database_id: 'db-1' } },
    ],
  };

  // What the GET returns: relations hydrated, but option ids and BlockNote blocks
  // still raw — labelizing them is the serialiser's job.
  const readRow = {
    id: 'rec-1',
    number: 7,
    title: 'A record',
    values: {
      name: 'A record',
      state: 'opt-done',
      details: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello', styles: {} }] }],
      epic: [{ id: 'rec-9', title: 'Platform', number: 9 }],
    },
  };

  // What POST/PATCH return: NO relation chips. This is the real asymmetry.
  const writeRow = {
    id: 'rec-1',
    number: 7,
    title: 'A record',
    values: { name: 'A record', state: 'opt-done', details: readRow.values.details },
  };

  function makeCtx(overrides: { readRow?: unknown } = {}): Ctx {
    const row = overrides.readRow ?? readRow;
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}') return { data: row };
        // resolveRecordId turns a public number into a uuid before any write.
        if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}') return { data: row };
        throw new Error(`unexpected GET ${path}`);
      },
      POST: async (path: string) => {
        if (path === '/api/v1/workspaces/{ws}/databases/{db}/records') return { data: writeRow };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}') return { data: {} };
        throw new Error(`unexpected POST ${path}`);
      },
      PATCH: async (path: string) => {
        if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}') return { data: writeRow };
        throw new Error(`unexpected PATCH ${path}`);
      },
      PUT: async () => ({ data: {} }),
      DELETE: async () => ({ data: {} }),
    };
    return { client: client as never, baseUrl: 'http://test', token: 'tok' };
  }

  function makeFakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    return { server: { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, handlers };
  }

  async function call(tool: string, args: Record<string, unknown>, ctx: Ctx = makeCtx()) {
    const { server, handlers } = makeFakeServer();
    registerTools(server, ctx);
    const result = await handlers.get(tool)!(args);
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text);
  }

  const base = { workspace: 'Eng', database: 'Issues' };

  it('get_record labelizes options, renders rich text, and includes url', async () => {
    const out = await call('get_record', { ...base, record: '7' });
    expect(out.values.state).toBe('Done');
    expect(out.values.details).toContain('hello');
    expect(out.url).toContain('/w/ws-1/d/db-1/r/');
  });

  it('update_record matches get_record FIELD FOR FIELD — including the relation', async () => {
    const read = await call('get_record', { ...base, record: '7' });
    const updated = await call('update_record', { ...base, record: '7', values: { state: 'Done' } });
    // The whole point of the ticket: no key may differ between a read and a write.
    expect(updated).toEqual(read);
    // Spelled out, because this is the one that regressed: the PATCH response has
    // no `epic`, so echoing it would drop the relation from a write that never
    // touched it.
    expect(updated.values.epic).toEqual([{ id: 'rec-9', title: 'Platform', number: 9 }]);
  });

  it('link_records matches get_record — not the raw row it used to return', async () => {
    const read = await call('get_record', { ...base, record: '7' });
    const linked = await call('link_records', { ...base, record: '7', relation_field: 'epic', targets: ['9'] });
    expect(linked).toEqual(read);
    // The three specific symptoms of returning the raw row.
    expect(linked.values.state).toBe('Done'); // not 'opt-done'
    expect(typeof linked.values.details).toBe('string'); // not BlockNote JSON
    expect(linked.url).toBeTruthy(); // was absent entirely
  });

  it('unlink_records matches get_record too', async () => {
    const read = await call('get_record', { ...base, record: '7' });
    const unlinked = await call('unlink_records', { ...base, record: '7', relation_field: 'epic', targets: ['9'] });
    expect(unlinked).toEqual(read);
  });

  it('create_record returns the READ-BACK record, so a created relation is visible', async () => {
    const out = await call('create_record', { ...base, values: { name: 'A record', state: 'Done' } });
    const record = out.record ?? out;
    expect(record.values.epic).toEqual([{ id: 'rec-9', title: 'Platform', number: 9 }]);
    expect(record.values.state).toBe('Done');
    expect(record.url).toBeTruthy();
  });

  it('create_record SAYS SO when the new record has no title', async () => {
    // This is how #343 itself came to exist: a nameless record returned as success.
    const untitled = { ...readRow, title: '', values: { ...readRow.values, name: '' } };
    const out = await call('create_record', { ...base, values: { state: 'Done' } }, makeCtx({ readRow: untitled }));
    expect(out.note).toMatch(/NO TITLE/);
    expect(out.note).toMatch(/values\.name/);
  });

  it('does NOT cry untitled when the record has one', async () => {
    const out = await call('create_record', { ...base, values: { name: 'A record' } });
    expect(out.note ?? '').not.toMatch(/NO TITLE/);
  });
});

/**
 * #343 defect 1 — the worst of the four, because it corrupted a write silently.
 *
 * `inputSchema` is a zod SHAPE and the SDK wraps it in a `z.object()`, which strips
 * unknown keys. A misspelled argument therefore vanished and the call still
 * succeeded. Note this was NEVER inconsistent between tools, as first suspected —
 * every tool stripped silently; the one error that looked like strictness was
 * really a MISSING REQUIRED argument being reported.
 */
describe('unknown tool arguments are rejected, not dropped (#343)', () => {
  function makeFakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    return { server: { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, handlers };
  }
  function handlersFor(): Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>> {
    const { server, handlers } = makeFakeServer();
    const client = { GET: async () => ({ data: [] }), POST: async () => ({ data: {} }) };
    registerTools(server, { client: client as never, baseUrl: 'http://test', token: 'tok' });
    return handlers;
  }

  it('rejects the exact mistake that filed #343 nameless — a top-level `title`', async () => {
    const res = await handlersFor().get('create_record')!({ workspace: 'Eng', database: 'Issues', title: 'Oops', values: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('"title"');
    // The message has to say what IS valid, or the model just guesses again.
    expect(res.content[0]!.text).toContain('values');
    // And it must promise nothing happened, so the model retries instead of
    // hunting for a half-written record.
    expect(res.content[0]!.text).toMatch(/Nothing was written/);
  });

  it('names the tool and every unknown argument it was given', async () => {
    const res = await handlersFor().get('get_record')!({ workspace: 'Eng', database: 'Issues', record: '7', foo: 1, bar: 2 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('get_record');
    expect(res.content[0]!.text).toContain('"foo"');
    expect(res.content[0]!.text).toContain('"bar"');
  });

  it('lets valid arguments through untouched', async () => {
    // list_workspaces takes nothing; it must still run rather than trip the guard.
    const res = await handlersFor().get('list_workspaces')!({});
    expect(res.isError).toBeFalsy();
  });

  it('ignores MCP protocol metadata (_meta), which is not a tool argument', async () => {
    const res = await handlersFor().get('list_workspaces')!({ _meta: { progressToken: 1 } });
    expect(res.isError).toBeFalsy();
  });
});

/**
 * #344 — filed as "self-relations are forced to Parent/Sub-items, discarding the
 * names the caller asked for". That diagnosis was WRONG, and the tests below pin
 * the real behaviour so nobody re-files it.
 *
 * The call that produced the report passed `name` / `reverse_name`. Those are not
 * arguments of this tool — it takes `field_name` / `reverse_field_name` — and the
 * SDK silently stripped them (#343), leaving an unnamed request that correctly got
 * the defaults. The API has always honoured custom self-relation names, and
 * `apps/api/test/self-relation-naming.test.ts` has always proved it: it creates
 * "Blocks" / "Blocked by" on a single database, and stacks four self-relations on
 * that same database, all 201.
 *
 * So #344 needed no relations change at all. What it needed was #343's guard (the
 * wrong names now raise) and a description that mentions self-relations exist.
 */
describe('create_relation self-relations (#344 — the misdiagnosis)', () => {
  function harness() {
    const calls: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const dbDetail = { id: 'db-1', name: 'Issues', qualifiedSlug: 'eng/issues', fields: [] };
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
        throw new Error(`unexpected GET ${path}`);
      },
      POST: async (_path: string, opts: { body: Record<string, unknown> }) => {
        calls.push(opts.body);
        return { data: { id: 'rel-1' } };
      },
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: client as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    return { handlers, calls };
  }

  it('forwards field_name / reverse_field_name for a SELF-relation', async () => {
    const { handlers, calls } = harness();
    const res = await handlers.get('create_relation')!({
      workspace: 'Eng',
      database: 'Issues',
      related_database: 'Issues',
      type: 'many_to_many',
      field_name: 'Blocked by',
      reverse_field_name: 'Blocks',
    });
    expect(res.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({
      database_a_id: 'db-1',
      database_b_id: 'db-1',
      cardinality: 'many_to_many',
      field_a_name: 'Blocked by',
      field_b_name: 'Blocks',
    });
  });

  it('rejects the exact wrong argument names that caused #344, instead of dropping them', async () => {
    const { handlers, calls } = harness();
    const res = await handlers.get('create_relation')!({
      workspace: 'Eng',
      database: 'Issues',
      related_database: 'Issues',
      name: 'Blocked By',
      reverse_name: 'Blocks',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('"name"');
    expect(res.content[0]!.text).toContain('"reverse_name"');
    // It must point at the right spelling, which is the whole cure here.
    expect(res.content[0]!.text).toContain('field_name');
    expect(res.content[0]!.text).toContain('reverse_field_name');
    // And crucially: no relation was created under the wrong name.
    expect(calls).toHaveLength(0);
  });

  it('still omits the name keys when the caller genuinely wants the defaults', async () => {
    const { handlers, calls } = harness();
    await handlers.get('create_relation')!({ workspace: 'Eng', database: 'Issues', related_database: 'Issues' });
    expect(calls[0]).not.toHaveProperty('field_a_name');
    expect(calls[0]).not.toHaveProperty('field_b_name');
  });
});

/**
 * A client that serialises EVERY argument as a string must still be able to
 * write. This was found the hard way: reads worked (their params are all
 * strings) while every write failed validation, which reads like a broken server
 * rather than a serialisation quirk. `parseStructuredParam` already existed for
 * this and never ran, because the zod inputSchema rejected first.
 */
describe('stringified arguments are coerced at the schema boundary', () => {
  it('parses a stringified RECORD — the update_record `values` case', () => {
    const schema = coerceStringified(z.record(z.string(), z.any()));
    expect(schema.parse('{"state":"Triage"}')).toEqual({ state: 'Triage' });
  });

  it('parses a stringified ARRAY — the link_records `targets` case', () => {
    const schema = coerceStringified(z.array(z.string()));
    expect(schema.parse('["4"]')).toEqual(['4']);
  });

  it('parses a stringified BOOLEAN — the link_records `replace` case', () => {
    const schema = coerceStringified(z.boolean());
    expect(schema.parse('true')).toBe(true);
    expect(schema.parse('false')).toBe(false);
  });

  it('parses a stringified NUMBER', () => {
    expect(coerceStringified(z.number()).parse('25')).toBe(25);
  });

  it('leaves a genuine string ALONE, quotes/braces and all', () => {
    // The important negative: a string param must never be JSON-parsed, or a
    // record named `{"a":1}` or `true` would silently change type.
    const schema = coerceStringified(z.string());
    expect(schema.parse('{"a":1}')).toBe('{"a":1}');
    expect(schema.parse('true')).toBe('true');
    expect(schema.parse('25')).toBe('25');
  });

  it('an unparseable string still fails with the SCHEMA error, not a parse error', () => {
    // A real caller mistake must keep reading as a shape problem.
    const schema = coerceStringified(z.array(z.string()));
    const result = schema.safeParse('not json at all');
    expect(result.success).toBe(false);
  });

  it('coerceInputSchema wraps every declared param and passes non-zod entries through', () => {
    const wrapped = coerceInputSchema({
      workspace: z.string(),
      targets: z.array(z.string()),
      notASchema: 'literal',
    }) as Record<string, { parse?: (v: unknown) => unknown }>;
    expect(wrapped.workspace!.parse!('JCM Agency')).toBe('JCM Agency');
    expect(wrapped.targets!.parse!('["4"]')).toEqual(['4']);
    expect(wrapped.notASchema).toBe('literal');
  });

  it('handles an absent or non-object inputSchema without throwing', () => {
    expect(coerceInputSchema(undefined)).toBeUndefined();
    expect(coerceInputSchema(null)).toBeNull();
  });
});

/**
 * #400 / #398 — the purpose line and the colour/option gaps.
 *
 * Driven through the real handlers, like the query_records block above, because
 * both tickets are about what actually reaches the API. #400's acceptance note is
 * explicit that "a description that exists but is not returned by the listing
 * tools is a failed acceptance", and #398's is that an option edit must be
 * non-destructive — neither is provable by reading the input schema.
 */
describe('descriptions and option editing over MCP (#400, #398)', () => {
  const optionsFixture = [
    { id: 'opt-todo', label: 'To Do', color: 'gray' },
    { id: 'opt-doing', label: 'Doing', color: 'gray' },
  ];
  const describedDb = {
    id: 'db-1',
    name: 'Voices',
    description: 'Tone-of-voice profiles we write in, one per publication.',
    qualifiedSlug: 'content/voices',
    spaceSlug: 'content',
    apiSlug: 'voices',
    fields: [
      { id: 'f-state', apiName: 'state', displayName: 'State', type: 'workflow', options: optionsFixture },
      { id: 'f-title', apiName: 'title', displayName: 'Title', type: 'title' },
    ],
  };

  /** Every request the tools made, so we can assert on the wire, not the intent. */
  interface Sent {
    method: string;
    path: string;
    body?: unknown;
    params?: unknown;
  }

  function makeCtx(sent: Sent[], dbOverride?: Record<string, unknown>): Ctx {
    const db = { ...describedDb, ...dbOverride };
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/databases') return { data: [db] };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: db };
        if (path === '/api/v1/workspaces/{ws}/spaces')
          return { data: [{ id: 'sp-1', name: 'Content', slug: 'content', description: 'All the writing.' }] };
        throw new Error(`unexpected GET ${path}`);
      },
      PATCH: async (path: string, opts: { body: unknown; params: unknown }) => {
        sent.push({ method: 'PATCH', path, body: opts.body, params: opts.params });
        return { data: { ok: true } };
      },
      DELETE: async (path: string, opts: { body: unknown; params: unknown }) => {
        sent.push({ method: 'DELETE', path, body: opts.body, params: opts.params });
        return { data: { ok: true } };
      },
      POST: async (path: string, opts: { body: unknown }) => {
        sent.push({ method: 'POST', path, body: opts.body });
        return { data: { ok: true } };
      },
    };
    return { client: client as never, baseUrl: 'http://test', token: 'tok' };
  }

  function harness(dbOverride?: Record<string, unknown>) {
    const sent: Sent[] = [];
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    registerTools(
      { registerTool: (name: string, _c: unknown, h: never) => void handlers.set(name, h as never) } as never,
      makeCtx(sent, dbOverride),
    );
    const call = async (tool: string, args: unknown) => {
      const res = await handlers.get(tool)!(args);
      if (res.isError) throw new Error(res.content[0]!.text);
      return JSON.parse(res.content[0]!.text) as never;
    };
    return { call, sent };
  }

  describe('#400 — the description reaches the reader', () => {
    it('describe_database returns it', async () => {
      const { call } = harness();
      const out = await call('describe_database', { workspace: 'Eng', database: 'Voices' }) as {
        description?: string;
      };
      expect(out.description).toBe('Tone-of-voice profiles we write in, one per publication.');
    });

    it('list_databases returns it — the listing an agent reads before choosing a target', async () => {
      const { call } = harness();
      const out = (await call('list_databases', { workspace: 'Eng' })) as Array<{ description?: string }>;
      expect(out[0]!.description).toBe('Tone-of-voice profiles we write in, one per publication.');
    });

    it('list_spaces returns it', async () => {
      const { call } = harness();
      const out = (await call('list_spaces', { workspace: 'Eng' })) as Array<{ description?: string }>;
      expect(out[0]!.description).toBe('All the writing.');
    });

    it('OMITS the key entirely when there is none, rather than emitting description: null', async () => {
      // An explicit null on every row of a listing an agent reads on every task
      // is pure noise, and "absent" already reads as "nobody has said".
      const { call } = harness({ description: null });
      const listed = (await call('list_databases', { workspace: 'Eng' })) as Array<Record<string, unknown>>;
      expect('description' in listed[0]!).toBe(false);
    });

    it('update_database sends a null description through — null CLEARS, it is not "falsy so skip"', async () => {
      const { call, sent } = harness();
      await call('update_database', { workspace: 'Eng', database: 'Voices', description: null });
      const patch = sent.find((s) => s.method === 'PATCH')!;
      expect(patch.body).toEqual({ description: null });
    });
  });

  describe('#398 — colour and option editing', () => {
    it('still moves a database between spaces — colour/description did not displace it', async () => {
      /*
       * Regression. Adding `color` and `description` to update_database rewrote
       * this handler's body-building block and dropped the `move_to_space` line
       * outright; lint noticed only because the argument became unused. Nothing
       * else would have — the tool would have accepted move_to_space, reported
       * success, and moved nothing.
       */
      const { call, sent } = harness();
      await call('update_database', {
        workspace: 'Eng',
        database: 'Voices',
        move_to_space: 'Content',
      });
      expect(sent.find((s) => s.method === 'PATCH')!.body).toEqual({ space_id: 'sp-1' });
    });

    it('update_database forwards a colour', async () => {
      const { call, sent } = harness();
      await call('update_database', { workspace: 'Eng', database: 'Voices', color: 'teal' });
      expect(sent.find((s) => s.method === 'PATCH')!.body).toEqual({ color: 'teal' });
    });

    it('recolours an EXISTING option, addressed by its label', async () => {
      /*
       * By label, not id: describe_database shows an agent labels and colours and
       * never option ids, so requiring an id would demand something the read path
       * does not emit — the #332 bug one level down.
       */
      const { call, sent } = harness();
      await call('update_field', {
        workspace: 'Eng',
        database: 'Voices',
        field: 'state',
        update_options: [{ option: 'To Do', color: 'blue' }],
      });
      const patch = sent.find((s) => s.method === 'PATCH')!;
      expect(patch.path).toBe('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}');
      expect((patch.params as { path: { option: string } }).path.option).toBe('opt-todo');
      expect(patch.body).toEqual({ color: 'blue' });
    });

    it('sends ONLY the keys given — a recolour must not blank the label', async () => {
      // The whole non-destructiveness claim rests on this: a PATCH carrying
      // `label: undefined` would be a rename to nothing.
      const { call, sent } = harness();
      await call('update_field', {
        workspace: 'Eng',
        database: 'Voices',
        field: 'state',
        update_options: [{ option: 'Doing', color: 'green' }],
      });
      expect(sent.find((s) => s.method === 'PATCH')!.body).toEqual({ color: 'green' });
    });

    it('names the real options when asked for one that does not exist', async () => {
      const { call } = harness();
      await expect(
        call('update_field', {
          workspace: 'Eng',
          database: 'Voices',
          field: 'state',
          update_options: [{ option: 'Blocked', color: 'red' }],
        }),
      ).rejects.toThrow(/To Do, Doing/);
    });

    it('removing an option does NOT auto-confirm — the refusal carries the usage count', async () => {
      /*
       * Defaulting confirm to true would silently destroy record values. The API
       * answers an unconfirmed delete with the number of records still holding the
       * option, which is exactly the sentence a user needs BEFORE it happens
       * (#398: "Removing an option states what happens to records that hold it").
       */
      const { call, sent } = harness();
      await call('update_field', {
        workspace: 'Eng',
        database: 'Voices',
        field: 'state',
        remove_options: [{ option: 'Doing' }],
      });
      expect(sent.find((s) => s.method === 'DELETE')!.body).toEqual({ confirm: false });
    });

    it('resolves reassign_to by label as well, so holders can be moved rather than cleared', async () => {
      const { call, sent } = harness();
      await call('update_field', {
        workspace: 'Eng',
        database: 'Voices',
        field: 'state',
        remove_options: [{ option: 'Doing', confirm: true, reassign_to: 'To Do' }],
      });
      expect(sent.find((s) => s.method === 'DELETE')!.body).toEqual({
        confirm: true,
        reassign_to: 'opt-todo',
      });
    });
  });
});

/**
 * #332 / #394 — querying through a view, and the bulk path.
 */
describe('view-scoped queries and bulk building (#332, #394)', () => {
  const viewConfig = {
    filters: { and: [{ field: 'state', op: 'eq', value: 'Doing' }] },
    sorts: [{ field: 'title', direction: 'asc' }],
  };
  const dbDetail = {
    id: 'db-1',
    name: 'Voices',
    qualifiedSlug: 'content/voices',
    fields: [
      {
        id: 'f-state',
        apiName: 'state',
        displayName: 'State',
        type: 'workflow',
        options: [
          { id: 'opt-todo', label: 'To Do' },
          { id: 'opt-doing', label: 'Doing' },
        ],
      },
      { id: 'f-title', apiName: 'title', displayName: 'Title', type: 'title' },
    ],
    views: [
      { id: 'view-abc', name: 'In progress', type: 'table', config: viewConfig },
      { id: 'view-plain', name: 'All', type: 'table', config: {} },
    ],
  };

  interface Sent { method: string; path: string; body?: unknown }

  function harness() {
    const sent: Sent[] = [];
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
        if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
        if (path === '/api/v1/packs/registry') return { data: [{ slug: 'crm', name: 'CRM' }] };
        if (path === '/api/v1/packs/registry/{slug}') return { data: { slug: 'crm', manifest: { databases: [] } } };
        throw new Error(`unexpected GET ${path}`);
      },
      POST: async (path: string, opts: { body: unknown }) => {
        sent.push({ method: 'POST', path, body: opts.body });
        if (path.endsWith('/records/query')) return { data: { data: [], next_cursor: null, has_more: false } };
        return { data: { ok: true } };
      },
      PATCH: async (path: string, opts: { body: unknown }) => {
        sent.push({ method: 'PATCH', path, body: opts.body });
        return { data: { ok: true } };
      },
    };
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    registerTools(
      { registerTool: (n: string, _c: unknown, h: never) => void handlers.set(n, h as never) } as never,
      { client: client as never, baseUrl: 'http://test', token: 'tok' } as Ctx,
    );
    const call = async (tool: string, args: unknown) => {
      const r = await handlers.get(tool)!(args);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text) as never;
    };
    return { call, sent, handlers };
  }

  const queryBody = (sent: Sent[]) =>
    sent.find((s) => s.path.endsWith('/records/query'))!.body as { filter?: unknown; sorts?: unknown };

  describe('#332 — "the records in this view", in one call', () => {
    it('applies the view\'s saved filter and sorts, resolved by view ID', async () => {
      // The id is what a shared `?view=<uuid>` URL carries — the whole point.
      const { call, sent } = harness();
      await call('query_records', { workspace: 'Eng', database: 'Voices', view: 'view-abc' });
      const body = queryBody(sent);
      expect(body.sorts).toEqual(viewConfig.sorts);
      // The label was mapped to an option id on the way through, as any filter is.
      expect(JSON.stringify(body.filter)).toContain('opt-doing');
    });

    it('resolves a view by NAME too', async () => {
      const { call, sent } = harness();
      await call('query_records', { workspace: 'Eng', database: 'Voices', view: 'In progress' });
      expect(queryBody(sent).sorts).toEqual(viewConfig.sorts);
    });

    it('an explicit filter OVERRIDES the view\'s — "this view, but only X" must be expressible', async () => {
      const { call, sent } = harness();
      await call('query_records', {
        workspace: 'Eng',
        database: 'Voices',
        view: 'view-abc',
        filter: { field: 'state', op: 'eq', value: 'To Do' },
      });
      expect(JSON.stringify(queryBody(sent).filter)).toContain('opt-todo');
    });

    it('a view with no saved filter queries everything, rather than sending undefined junk', async () => {
      const { call, sent } = harness();
      await call('query_records', { workspace: 'Eng', database: 'Voices', view: 'All' });
      const body = queryBody(sent);
      expect(body.filter).toBeUndefined();
      expect(body.sorts).toEqual([]);
    });

    it('names the real views when asked for one that does not exist', async () => {
      const { call } = harness();
      await expect(
        call('query_records', { workspace: 'Eng', database: 'Voices', view: 'Nope' }),
      ).rejects.toThrow(/In progress, All/);
    });

    it('does NOT expand `me` itself — the server resolves it against the caller', async () => {
      /*
       * #332 held this feature back partly because "a view filter can reference
       * `me`". Passing the AST through unexpanded is not a shortcut: the API's
       * query compiler resolves `me` from the authenticated caller, so expanding
       * it here would freeze it to whoever happened to ask.
       */
      const meView = { id: 'v-me', name: 'Mine', type: 'table', config: { filters: { field: 'assignee', op: 'eq', value: 'me' } } };
      dbDetail.views.push(meView as never);
      const { call, sent } = harness();
      await call('query_records', { workspace: 'Eng', database: 'Voices', view: 'v-me' });
      expect(JSON.stringify(queryBody(sent).filter)).toContain('"me"');
      dbDetail.views.pop();
    });
  });

  describe('#394 — one call instead of ninety', () => {
    it('build_schema passes the plan through VERBATIM', async () => {
      // Reshaping it here would turn the service's actionable 422 ("this part of
      // your plan is wrong") into a confusing one, and would be a second copy of
      // a schema that already exists.
      const { call, sent } = harness();
      const plan = { summary: 'x', scenario: 'crm', databases: [{ action: 'create', name: 'Leads', space: 'S', fields: [] }] };
      await call('build_schema', { workspace: 'Eng', plan });
      expect(sent.find((s) => s.path.endsWith('/architect/build'))!.body).toEqual({ plan });
    });

    it('propose_schema creates nothing — it only proposes', async () => {
      const { call, sent } = harness();
      await call('propose_schema', { workspace: 'Eng', goal: 'track clients' });
      const paths = sent.map((s) => s.path);
      expect(paths).toContain('/api/v1/workspaces/{ws}/architect/propose');
      expect(paths).not.toContain('/api/v1/workspaces/{ws}/architect/build');
    });

    it('install_pack with preview writes NOTHING', async () => {
      const { call, sent } = harness();
      await call('install_pack', { workspace: 'Eng', slug: 'crm', preview: true });
      const paths = sent.map((s) => s.path);
      expect(paths).toContain('/api/v1/workspaces/{ws}/packs/preview');
      expect(paths).not.toContain('/api/v1/workspaces/{ws}/packs/install');
    });

    it('install_pack without preview installs', async () => {
      const { call, sent } = harness();
      await call('install_pack', { workspace: 'Eng', slug: 'crm' });
      expect(sent.map((s) => s.path)).toContain('/api/v1/workspaces/{ws}/packs/install');
    });

    it('create_records sends ONE request for many records', async () => {
      const { call, sent } = harness();
      await call('create_records', {
        workspace: 'Eng',
        database: 'Voices',
        records: [{ values: { title: 'a' } }, { values: { title: 'b' } }, { values: { title: 'c' } }],
      });
      const writes = sent.filter((s) => s.path.endsWith('/records/batch'));
      expect(writes).toHaveLength(1);
      expect((writes[0]!.body as { records: unknown[] }).records).toHaveLength(3);
    });

    it('a batch write resolves select LABELS, exactly as the single-record write does', async () => {
      // A batch taking raw option ids while create_record takes labels would be
      // a second, quietly different write contract.
      const { call, sent } = harness();
      await call('create_records', {
        workspace: 'Eng',
        database: 'Voices',
        records: [{ values: { state: 'Doing' } }],
      });
      expect(JSON.stringify(sent.find((s) => s.path.endsWith('/records/batch'))!.body)).toContain('opt-doing');
    });

    it('update_records applies one patch to many ids in a single call', async () => {
      const { call, sent } = harness();
      await call('update_records', {
        workspace: 'Eng',
        database: 'Voices',
        record_ids: ['r1', 'r2'],
        values: { state: 'To Do' },
      });
      const patch = sent.find((s) => s.method === 'PATCH' && s.path.endsWith('/records/batch'))!;
      expect((patch.body as { record_ids: string[] }).record_ids).toEqual(['r1', 'r2']);
      expect(JSON.stringify(patch.body)).toContain('opt-todo');
    });
  });
});
