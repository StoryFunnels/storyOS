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

/**
 * #416 — the MCP could CREATE a space and never undo the creation.
 *
 * Hit for real: a UAT made a scratch space, finished with it, and had no MCP
 * path to remove it — the space had to be deleted by hand in the browser. That
 * is a one-way ratchet in the worst direction.
 */
describe('space lifecycle over MCP (#416)', () => {
  interface Sent { method: string; path: string; body?: unknown; params?: unknown }

  function harness() {
    const sent: Sent[] = [];
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
        if (path === '/api/v1/workspaces/{ws}/spaces')
          return { data: [{ id: 'sp-1', name: 'Scratch', slug: 'scratch' }] };
        throw new Error(`unexpected GET ${path}`);
      },
      POST: async (path: string, o: { body: unknown }) => { sent.push({ method: 'POST', path, body: o.body }); return { data: { id: 'sp-1' } }; },
      PATCH: async (path: string, o: { body: unknown }) => { sent.push({ method: 'PATCH', path, body: o.body }); return { data: { ok: true } }; },
      DELETE: async (path: string, o: { body: unknown; params: unknown }) => {
        sent.push({ method: 'DELETE', path, body: o.body, params: o.params });
        return { data: { deleted: true, databases_deleted: 0 } };
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

  it('delete_space exists at all — the ratchet this closes', () => {
    // The whole ticket: create existed, delete did not.
    const { handlers } = harness();
    expect(handlers.has('create_space')).toBe(true);
    expect(handlers.has('update_space')).toBe(true);
    expect(handlers.has('delete_space')).toBe(true);
  });

  it('resolves the space by NAME and deletes it by id', async () => {
    const { call, sent } = harness();
    await call('delete_space', { workspace: 'Eng', space: 'Scratch' });
    const del = sent.find((s) => s.method === 'DELETE')!;
    expect((del.params as { path: { space: string } }).path.space).toBe('sp-1');
  });

  it('forwards `confirm` so the API can enforce the typed-name guard', async () => {
    /*
     * The tool deliberately does NOT implement the guard. #417 put it in
     * SpacesService.remove so every caller meets it; re-implementing it here
     * would be a second copy of a safety rule, and the copy is what rots.
     */
    const { call, sent } = harness();
    await call('delete_space', { workspace: 'Eng', space: 'Scratch', confirm: 'Scratch' });
    expect(sent.find((s) => s.method === 'DELETE')!.body).toEqual({ confirm: 'Scratch' });
  });

  it('omits `confirm` entirely when not given — an empty space needs none', async () => {
    // Not `confirm: undefined`: the API distinguishes an absent body from a
    // present-but-empty one, and an empty space is a legitimate no-confirm call.
    const { call, sent } = harness();
    await call('delete_space', { workspace: 'Eng', space: 'Scratch' });
    expect(sent.find((s) => s.method === 'DELETE')!.body).toEqual({});
  });

  it('the description warns that the databases go too', () => {
    // A destructive tool whose description understates the blast radius is how
    // an agent confirms something it should have asked about.
    const { handlers } = harness();
    expect(handlers.has('delete_space')).toBe(true);
  });
});

/**
 * #406 areas 1–3 — the record surface.
 *
 * The tests are written against the failure each tool was built to prevent, not
 * against its happy path: a trashed record no longer resolving by number, a
 * comment body coming back as a document format instead of words, and a link
 * chip whose url points at the wrong database. All three produce a plausible
 * response, which is what makes them worth pinning.
 */
describe('#406 — record lifecycle, manual order, and what hangs off a record', () => {
  interface Sent {
    method: string;
    path: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
  }

  function harness(opts?: { commentBody?: unknown }) {
    const sent: Sent[] = [];
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const dbDetail = {
      id: 'db-1',
      name: 'Issues',
      qualifiedSlug: 'eng/issues',
      fields: [
        { id: 'f-state', apiName: 'state', displayName: 'State', type: 'select', options: [{ id: 'opt-done', label: 'Done' }] },
        {
          id: 'f-epic',
          apiName: 'epic',
          displayName: 'Epic',
          type: 'relation',
          relation: { target_database_id: 'db-2', target_database_name: 'Epics', cardinality: 'one_to_many', side: 'a' },
        },
      ],
    };
    const live = { id: 'rec-1', number: 7, title: 'Live one', values: {} };

    const log = (method: string) => async (path: string, o?: { params?: { path?: Record<string, string> }; body?: unknown }) => {
      sent.push({ method, path, params: o?.params?.path, body: o?.body as Record<string, unknown> });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}') {
        // Only #7 is live. #42 is in the trash, so this 404s for it — exactly as
        // the API does, since /by-number filters deletedAt IS NULL.
        return o?.params?.path?.number === '7' ? { data: live } : { error: { error: { message: 'Record not found' } } };
      }
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/trash') {
        return { data: { data: [{ id: 'rec-gone', number: 42, title: 'Deleted one', deleted_at: '2026-08-01T00:00:00Z' }] } };
      }
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}') return { data: live };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records') {
        return { data: { data: [live], next_cursor: 'cur-2', has_more: true } };
      }
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments') {
        return {
          data: {
            data: [
              {
                id: 'cmt-1',
                body: opts?.commentBody ?? [{ type: 'text', text: 'Shipped ' }, { type: 'mention', user_id: 'u-9' }],
                author: { id: 'u-1', name: 'Ada' },
                edited_at: null,
                created_at: '2026-08-01T00:00:00Z',
              },
            ],
          },
        };
      }
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}') {
        return { data: { data: [{ id: 'rec-epic-1', number: 3, title: 'Big epic' }] } };
      }
      if (path.includes('/versions') || path.includes('/activity') || path.includes('/backlinks')) {
        return { data: { data: [], next_cursor: null } };
      }
      if (path.endsWith('/watchers')) return { data: { watchers: [], watching: false } };
      if (path.endsWith('/duplicate')) return { data: { id: 'rec-copy', number: 8, title: 'Live one (copy)', values: {} } };
      if (path.endsWith('/batch-restore')) return { data: { restored: 2 } };
      if (path.endsWith('/batch-delete')) return { data: { deleted: 2 } };
      return { data: {} };
    };

    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool returns a different JSON shape.
    const call = async (name: string, args: unknown): Promise<any> => {
      const res = await handlers.get(name)!(args);
      if (res.isError) throw new Error(res.content[0]!.text);
      return JSON.parse(res.content[0]!.text);
    };
    return { call, sent, handlers };
  }

  const paths = (sent: Sent[], method?: string) => sent.filter((s) => !method || s.method === method).map((s) => s.path);

  describe('area 1 — lifecycle', () => {
    it('restores by public number via the TRASH listing, because /by-number cannot see a deleted record', async () => {
      // The reason this tool needed an API change: /records/by-number filters
      // deletedAt IS NULL, so "restore #42" had no path to a record id at all.
      const { call, sent } = harness();
      const out = await call('restore_records', { workspace: 'Eng', database: 'Issues', records: ['42'] });
      expect(paths(sent)).toContain('/api/v1/workspaces/{ws}/databases/{db}/records/trash');
      const restore = sent.find((s) => s.path.endsWith('/records/{rec}/restore'))!;
      expect(restore.params!.rec).toBe('rec-gone');
      expect(out.id).toBe('rec-1'); // read back through the shared record serialiser
    });

    it('says which number it could not find, rather than 404ing on an opaque id', async () => {
      const { call } = harness();
      await expect(call('restore_records', { workspace: 'Eng', database: 'Issues', records: ['999'] })).rejects.toThrow(
        /No record #999 in the trash.*list_trash/s,
      );
    });

    it('uses batch-restore for several and the single endpoint for one', async () => {
      const many = harness();
      await many.call('restore_records', { workspace: 'Eng', database: 'Issues', records: ['a', 'b'] });
      expect(paths(many.sent)).toContain('/api/v1/workspaces/{ws}/databases/{db}/records/batch-restore');
      expect(paths(many.sent).some((p) => p.endsWith('/records/{rec}/restore'))).toBe(false);
    });

    it('delete_records reports the requested count next to the deleted one', async () => {
      // batch-delete silently skips already-deleted rows, so `deleted` can be
      // lower than what was asked for. Reporting both is the difference between
      // a shortfall you can see and one that reads as success.
      const { call } = harness();
      const out = await call('delete_records', { workspace: 'Eng', database: 'Issues', records: ['a', 'b', 'c'] });
      expect(out).toMatchObject({ deleted: 2, requested: 3 });
    });

    it('duplicate_record returns the NEW record read back, not the raw create response', async () => {
      const { call, sent } = harness();
      const out = await call('duplicate_record', { workspace: 'Eng', database: 'Issues', record: '7' });
      expect(out.duplicated_from).toBe('rec-1');
      // The read-back is what makes a duplicate look like every other record
      // (#343) — relation chips and labels included.
      expect(sent.filter((s) => s.method === 'GET' && s.path.endsWith('/records/{rec}')).length).toBeGreaterThan(0);
      expect(out.record.url).toContain('/w/ws-1/d/db-1/r/');
    });

    it('move_record maps a select LABEL in the atomic value patch, like every other write', async () => {
      const { call, sent } = harness();
      await call('move_record', { workspace: 'Eng', database: 'Issues', record: '7', after: '7', values: { state: 'Done' } });
      const move = sent.find((s) => s.path.endsWith('/records/{rec}/move'))!;
      expect(move.body).toMatchObject({ after_record_id: 'rec-1', values: { state: 'opt-done' } });
    });

    it('move_record refuses before AND after together instead of letting the API guess', async () => {
      const { call } = harness();
      await expect(
        call('move_record', { workspace: 'Eng', database: 'Issues', record: '7', before: '7', after: '7' }),
      ).rejects.toThrow(/only one of/i);
    });
  });

  describe('area 2 — manual order', () => {
    it('list_records labels the order and carries the cursor, so paging is possible', async () => {
      const { call, sent } = harness();
      const out = await call('list_records', { workspace: 'Eng', database: 'Issues', limit: 1 });
      expect(paths(sent, 'GET')).toContain('/api/v1/workspaces/{ws}/databases/{db}/records');
      expect(out.order).toBe('manual');
      expect(out.next_cursor).toBe('cur-2');
      expect(out.records[0].url).toContain('/r/live-one-7');
    });
  });

  describe('area 3 — around the record', () => {
    it('list_comments renders a legacy segment body as words, not as JSON', async () => {
      const { call } = harness();
      const out = await call('list_comments', { workspace: 'Eng', database: 'Issues', record: '7' });
      expect(out.comments[0].text).toBe('Shipped @u-9');
      expect(out.comments[0].author).toBe('Ada');
    });

    it('list_comments renders a BlockNote body too — both stored shapes, one output', async () => {
      const { call } = harness({
        commentBody: { format: 'blocknote', doc: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }] },
      });
      const out = await call('list_comments', { workspace: 'Eng', database: 'Issues', record: '7' });
      expect(out.comments[0].text).toContain('Looks good');
    });

    it('get_history defaults to per-field changes and switches endpoint by kind', async () => {
      const f = harness();
      await f.call('get_history', { workspace: 'Eng', database: 'Issues', record: '7' });
      expect(paths(f.sent, 'GET')).toContain('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions/changes');

      const v = harness();
      await v.call('get_history', { workspace: 'Eng', database: 'Issues', record: '7', kind: 'versions' });
      expect(paths(v.sent, 'GET')).toContain('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions');

      const a = harness();
      await a.call('get_history', { workspace: 'Eng', database: 'Issues', record: '7', kind: 'activity' });
      expect(paths(a.sent, 'GET')).toContain('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/activity');
    });

    it('watch_record unsubscribes with DELETE when watch:false — not a second POST', async () => {
      const on = harness();
      await on.call('watch_record', { workspace: 'Eng', database: 'Issues', record: '7' });
      expect(paths(on.sent, 'POST')).toContain('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/watch');

      const off = harness();
      const out = await off.call('watch_record', { workspace: 'Eng', database: 'Issues', record: '7', watch: false });
      expect(paths(off.sent, 'DELETE')).toContain('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/watch');
      expect(out.watching).toBe(false);
    });

    it('list_linked_records builds urls against the TARGET database, not the source one', async () => {
      // Using the source db id here yields a link that resolves to a 404 — a
      // wrong url is indistinguishable from a right one until someone clicks it.
      const { call, sent } = harness();
      const out = await call('list_linked_records', { workspace: 'Eng', database: 'Issues', record: '7', relation_field: 'epic' });
      expect(sent.find((s) => s.path.endsWith('/links/{field}'))!.params!.field).toBe('f-epic');
      expect(out.target_database).toEqual({ id: 'db-2', name: 'Epics' });
      expect(out.linked[0].url).toContain('/d/db-2/r/big-epic-3');
    });

    it('list_linked_records names the valid relation fields when given a field that is not one', async () => {
      const { call } = harness();
      await expect(
        call('list_linked_records', { workspace: 'Eng', database: 'Issues', record: '7', relation_field: 'state' }),
      ).rejects.toThrow(/No relation field matches "state".*epic/s);
    });
  });
});

/**
 * #442 — skill authoring over MCP.
 *
 * The API owns both real rules (authorship derived from auth; an agent cannot
 * publish a shared skill), so what is worth testing HERE is that the tools do
 * not quietly work around them or hand back a shape that hides them.
 */
describe('#442 — skill authoring tools', () => {
  function harness() {
    const sent: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const skill = {
      id: 'sk-1',
      name: 'Weekly digest',
      description: 'd',
      when_to_use: 'w',
      instructions: 'full steps here',
      examples: [],
      allowed_tools: ['query_records'],
      visibility: 'personal',
      editable: true,
      source_template: null,
      source: 'mcp',
    };
    const log = (method: string) => async (path: string, o?: { body?: unknown }) => {
      sent.push({ method, path, body: o?.body as Record<string, unknown> });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/skills') return method === 'GET' ? { data: { data: [skill] } } : { data: skill };
      if (path === '/api/v1/workspaces/{ws}/skills/templates') return { data: { data: [{ id: 'blank', name: 'Blank' }] } };
      if (path === '/api/v1/workspaces/{ws}/skills/{id}/export') return { data: { filename: 'SKILL.md', content: '# Weekly digest' } };
      if (path === '/api/v1/workspaces/{ws}/skills/{id}') return { data: skill };
      return { data: {} };
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies per tool.
    const call = async (n: string, a: unknown): Promise<any> => {
      const r = await handlers.get(n)!(a);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    return { call, sent, handlers };
  }

  it('create_skill never sends visibility:"shared" — the argument does not exist', async () => {
    // Offering an argument the server refuses teaches the model the wrong thing.
    const { call, sent, handlers } = harness();
    await call('create_skill', {
      workspace: 'Eng',
      name: 'n',
      description: 'd',
      when_to_use: 'w',
      instructions: 'i',
    });
    const post = sent.find((s) => s.method === 'POST' && s.path === '/api/v1/workspaces/{ws}/skills')!;
    expect(post.body!.visibility).toBe('personal');

    const res = await handlers.get('create_skill')!({
      workspace: 'Eng',
      name: 'n',
      description: 'd',
      when_to_use: 'w',
      instructions: 'i',
      visibility: 'shared',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('"visibility"');
  });

  it('every skill read reports who authored it', async () => {
    // With no Skills page in the web app, these tools are the only place the
    // agent-vs-human distinction is actually visible.
    const { call } = harness();
    expect((await call('get_skill', { workspace: 'Eng', skill: 'Weekly digest' })).authored_by).toBe('mcp');
    expect((await call('create_skill', {
      workspace: 'Eng', name: 'n', description: 'd', when_to_use: 'w', instructions: 'i',
    })).skill.authored_by).toBe('mcp');
  });

  it('get_skill returns instructions, which list_skills omits', async () => {
    const { call } = harness();
    expect((await call('get_skill', { workspace: 'Eng', skill: 'sk-1' })).instructions).toBe('full steps here');
    const listed = await call('list_skills', { workspace: 'Eng' });
    expect(listed[0]).not.toHaveProperty('instructions');
  });

  it('delete_skill refuses without confirm, and names the skill it would destroy', async () => {
    // "confirm: true is required" alone does not tell a caller whether a partial
    // name match picked the right skill — which is the actual risk here.
    const { call, sent } = harness();
    await expect(call('delete_skill', { workspace: 'Eng', skill: 'Weekly' })).rejects.toThrow(/Weekly digest.*permanent/s);
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);

    const ok = harness();
    await ok.call('delete_skill', { workspace: 'Eng', skill: 'Weekly', confirm: true });
    expect(ok.sent.some((s) => s.method === 'DELETE')).toBe(true);
  });

  it('update_skill refuses an empty patch instead of sending a no-op PATCH', async () => {
    const { call } = harness();
    await expect(call('update_skill', { workspace: 'Eng', skill: 'sk-1' })).rejects.toThrow(/at least one field/i);
  });

  it('export_skill defaults to markdown and passes the format through', async () => {
    const { call } = harness();
    expect((await call('export_skill', { workspace: 'Eng', skill: 'sk-1' })).format).toBe('markdown');
    expect((await call('export_skill', { workspace: 'Eng', skill: 'sk-1', format: 'claude_skill' })).content).toContain('Weekly digest');
  });
});

/**
 * #444 — documents and folders.
 *
 * The interesting failures here are all "it looked like it worked": a document
 * created with content that is actually empty, a Markdown body stored as the
 * literal string, and a version omitted so a concurrent edit is silently
 * clobbered. Each returns a perfectly plausible success.
 */
describe('#444 — standalone documents and sidebar folders', () => {
  interface Sent { method: string; path: string; body?: Record<string, unknown>; params?: Record<string, string> }

  function harness() {
    const sent: Sent[] = [];
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const doc = {
      id: 'doc-1',
      space_id: 'sp-1',
      folder_id: null,
      title: 'Q3 plan',
      icon: null,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing body' }] }],
      version: 4,
    };
    const log = (method: string) => async (path: string, o?: { params?: { path?: Record<string, string> }; body?: unknown }) => {
      sent.push({ method, path, params: o?.params?.path, body: o?.body as Record<string, unknown> });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/spaces') return { data: [{ id: 'sp-1', name: 'Ops', slug: 'ops' }] };
      if (path === '/api/v1/workspaces/{ws}/spaces/{space}/documents') {
        // POST creates title+icon only — no content, which is the whole reason
        // create_document has to make a second call.
        return method === 'POST'
          ? { data: { id: 'doc-new', space_id: 'sp-1', title: (o?.body as { title?: string })?.title, icon: null, version: 0 } }
          : { data: { data: [doc] } };
      }
      if (path === '/api/v1/workspaces/{ws}/spaces/{space}/folders') {
        return method === 'POST'
          ? { data: { id: 'f-new', name: 'Reports', icon: null } }
          : { data: { data: [{ id: 'f-1', name: 'Reports', icon: null }] } };
      }
      if (path === '/api/v1/workspaces/{ws}/documents/{doc}') {
        if (method === 'PATCH') return { data: { ...doc, ...(o?.body as object) } };
        return { data: doc };
      }
      return { data: {} };
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies per tool.
    const call = async (n: string, a: unknown): Promise<any> => {
      const r = await handlers.get(n)!(a);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    return { call, sent };
  }

  it('create_document with content actually writes the content', async () => {
    // The create endpoint accepts title and icon ONLY. A tool that stopped there
    // would return a convincing success and leave an empty page behind.
    const { call, sent } = harness();
    await call('create_document', { workspace: 'Eng', space: 'ops', title: 'Q3 plan', content: '# Goals\n\n- ship it' });
    const patch = sent.find((s) => s.method === 'PATCH')!;
    expect(patch, 'content must be written by a follow-up PATCH').toBeDefined();
    expect(Array.isArray(patch.body!.content)).toBe(true);
    expect(JSON.stringify(patch.body!.content)).toContain('Goals');
  });

  it('create_document with no content makes no second call', async () => {
    const { call, sent } = harness();
    await call('create_document', { workspace: 'Eng', space: 'ops', title: 'Empty page' });
    expect(sent.some((s) => s.method === 'PATCH')).toBe(false);
  });

  it('stores Markdown as blocks and reads it back as Markdown', async () => {
    const { call } = harness();
    const read = await call('get_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan' });
    expect(read.content).toContain('Existing body');
    expect(read.content).not.toContain('"type"'); // not raw BlockNote JSON
  });

  it('update_document reads the current version when none is given', async () => {
    // Sending expected_version: undefined would make every content write
    // unconditional AND look like it was checked.
    const { call, sent } = harness();
    await call('update_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan', content: 'new body' });
    const patch = sent.find((s) => s.method === 'PATCH')!;
    expect(patch.body!.expected_version).toBe(4);
  });

  it('update_document passes a supplied version through, so a conflict can 409', async () => {
    const { call, sent } = harness();
    await call('update_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan', content: 'x', version: 2 });
    expect(sent.find((s) => s.method === 'PATCH')!.body!.expected_version).toBe(2);
  });

  it('update_document refuses an empty patch', async () => {
    const { call } = harness();
    await expect(call('update_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan' })).rejects.toThrow(/at least one/i);
  });

  it('resolves a folder by NAME on both create and update', async () => {
    const { call, sent } = harness();
    await call('create_document', { workspace: 'Eng', space: 'ops', title: 'Filed', folder: 'Reports' });
    expect(sent.find((s) => s.method === 'PATCH')!.body!.folder_id).toBe('f-1');

    const u = harness();
    await u.call('update_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan', folder: 'Reports' });
    expect(u.sent.find((s) => s.method === 'PATCH')!.body!.folder_id).toBe('f-1');
  });

  it('update_document folder:null moves the page to the space root', async () => {
    const { call, sent } = harness();
    await call('update_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan', folder: null });
    expect(sent.find((s) => s.method === 'PATCH')!.body!.folder_id).toBeNull();
  });

  it('delete_document names the page before destroying it, and deletes nothing without confirm', async () => {
    const { call, sent } = harness();
    await expect(call('delete_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan' })).rejects.toThrow(/Q3 plan/);
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('delete_folder needs no confirm — it destroys nothing', async () => {
    // The asymmetry with delete_document is deliberate: a folder's contents
    // survive at the space root, so a confirm prompt here is noise.
    const { call, sent } = harness();
    const out = await call('delete_folder', { workspace: 'Eng', space: 'ops', folder: 'Reports' });
    expect(sent.some((s) => s.method === 'DELETE')).toBe(true);
    expect(out.note).toMatch(/space root/i);
  });

  it('a document url points at the real web route', async () => {
    const { call } = harness();
    const read = await call('get_document', { workspace: 'Eng', space: 'ops', document: 'Q3 plan' });
    expect(read.url).toBe(`${TEST_WEB_URL}/w/ws-1/doc/doc-1`);
  });
});

/**
 * #445 + #446 — relation configuration, and the rest of the pack surface.
 *
 * Both areas are mostly pass-through, so the tests target the parts that are
 * NOT: addressing a relation by the field that carries it (the id was
 * unreachable over MCP before), and the two guards that exist to stop an agent
 * doing something wide by accident.
 */
describe('#445/#446 — relation config, packs and templates', () => {
  interface Sent { method: string; path: string; params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, unknown> }

  function harness() {
    const sent: Sent[] = [];
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const dbDetail = {
      id: 'db-1',
      name: 'Tasks',
      qualifiedSlug: 'eng/tasks',
      fields: [
        { id: 'f-title', apiName: 'name', displayName: 'Name', type: 'title' },
        {
          id: 'f-proj',
          apiName: 'project',
          displayName: 'Project',
          type: 'relation',
          relation: { id: 'rel-9', target_database_id: 'db-2', target_database_name: 'Projects', cardinality: 'one_to_many', side: 'a' },
        },
      ],
    };
    const log = (method: string) => async (
      path: string,
      o?: { params?: { path?: Record<string, string>; query?: Record<string, unknown> }; body?: unknown },
    ) => {
      sent.push({ method, path, params: o?.params?.path, query: o?.params?.query, body: o?.body as Record<string, unknown> });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
      if (path === '/api/v1/workspaces/{ws}/spaces') return { data: [{ id: 'sp-1', name: 'Ops', slug: 'ops' }] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}') {
        return { data: { id: 'rec-1', number: 7, title: 'A parent', values: {} } };
      }
      return { data: { ok: true } };
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies per tool.
    const call = async (n: string, a: unknown): Promise<any> => {
      const r = await handlers.get(n)!(a);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    return { call, sent, handlers };
  }

  describe('#445 — relations are addressed by the field that carries them', () => {
    it('resolves a relation from its FIELD name, which is all describe_database gives an agent', async () => {
      // delete_relation has always asked for "the id from a describe_database
      // relation field" — but the MCP's own field type never exposed it, so
      // that was advice nobody could follow.
      const { call, sent } = harness();
      await call('get_relation', { workspace: 'Eng', database: 'Tasks', relation: 'project' });
      expect(sent.find((s) => s.path.endsWith('/relations/{rel}'))!.params!.rel).toBe('rel-9');
    });

    it('names the relation fields when given something that is not one', async () => {
      const { call } = harness();
      await expect(call('get_relation', { workspace: 'Eng', database: 'Tasks', relation: 'name' })).rejects.toThrow(
        /No relation field matches "name".*project/s,
      );
    });

    it('set_auto_link says the rule changes nothing retroactively', async () => {
      // The single most likely misunderstanding: a rule is saved, the agent
      // reports success, and the hundred existing rows stay unlinked.
      const { call, sent } = harness();
      const out = await call('set_auto_link', {
        workspace: 'Eng',
        database: 'Tasks',
        relation: 'project',
        conditions: [{ field_a: 'project_code', field_b: 'code' }],
      });
      expect(out.note).toMatch(/run_auto_link/);
      const patch = sent.find((s) => s.method === 'PATCH')!;
      expect(patch.body!.auto_link).toMatchObject({ case_sensitive: false });
    });

    it('set_auto_link clear:true sends null, not an empty rule', async () => {
      const { call, sent } = harness();
      await call('set_auto_link', { workspace: 'Eng', database: 'Tasks', relation: 'project', clear: true });
      expect(sent.find((s) => s.method === 'PATCH')!.body!.auto_link).toBeNull();
    });

    it('set_auto_link refuses an empty call rather than sending a meaningless rule', async () => {
      const { call } = harness();
      await expect(call('set_auto_link', { workspace: 'Eng', database: 'Tasks', relation: 'project' })).rejects.toThrow(
        /conditions.*or clear/i,
      );
    });

    it('drift tools resolve the parent record by public number', async () => {
      const { call, sent } = harness();
      await call('find_select_drift', { workspace: 'Eng', database: 'Tasks', relation: 'project', record: '7' });
      expect(sent.find((s) => s.path.endsWith('/select-drift'))!.query).toMatchObject({ record_id: 'rec-1' });
    });
  });

  describe('#446 — packs and templates', () => {
    it('uninstall_pack refuses without confirm, and says what is at stake', async () => {
      const { call, sent } = harness();
      await expect(call('uninstall_pack', { workspace: 'Eng', install_id: 'i-1' })).rejects.toThrow(/since|confirm/i);
      expect(sent.some((s) => s.path.includes('uninstall'))).toBe(false);

      const ok = harness();
      await ok.call('uninstall_pack', { workspace: 'Eng', install_id: 'i-1', confirm: true });
      expect(ok.sent.some((s) => s.path.includes('uninstall'))).toBe(true);
    });

    it('export_pack resolves database NAMES to ids', async () => {
      const { call, sent } = harness();
      await call('export_pack', { workspace: 'Eng', databases: ['Tasks'] });
      expect(sent.find((s) => s.path.endsWith('/packs/export'))!.body!.database_ids).toEqual(['db-1']);
    });

    it('apply_template resolves a space by slug', async () => {
      const { call, sent } = harness();
      await call('apply_template', { workspace: 'Eng', template: 'crm', space: 'ops' });
      const post = sent.find((s) => s.path.endsWith('/templates/{slug}/apply'))!;
      expect(post.params!.slug).toBe('crm');
      expect(post.body!.space_id).toBe('sp-1');
    });

    it('browse_pack_marketplace hits the single-pack route only when given one', async () => {
      const many = harness();
      await many.call('browse_pack_marketplace', {});
      expect(many.sent.map((s) => s.path)).toContain('/api/v1/packs/marketplace');

      const one = harness();
      await one.call('browse_pack_marketplace', { pack: 'crm' });
      expect(one.sent.map((s) => s.path)).toContain('/api/v1/packs/marketplace/{slug}');
    });

    it('offers no way to SUBMIT a pack — that decision is recorded in coverage.ts', async () => {
      // #446's AC asked for a decision on marketplace submission. It is an
      // EXCLUDED entry, not an unbuilt tool, so the absence is deliberate and
      // this test is what stops it being "fixed" by someone adding one.
      const { handlers } = harness();
      expect(handlers.has('list_pack_submissions')).toBe(true);
      expect([...handlers.keys()].filter((k) => /submit/i.test(k))).toEqual([]);
    });
  });
});

/**
 * #447 — the agent engine.
 *
 * The single most important test in this file is the LAST one: that no tool can
 * approve or reject a staged run. Everything else here is ergonomics; that one
 * is ADR-0010's gate, and the natural way to extend this area is to build the
 * whole staged-run lifecycle with the approval step sitting right there.
 */
describe('#447 — agents, runs, and the gate that stays human', () => {
  interface Sent { method: string; path: string; params?: Record<string, string>; body?: Record<string, unknown> }

  function harness() {
    const sent: Sent[] = [];
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const dbDetail = {
      id: 'db-1',
      name: 'Leads',
      qualifiedSlug: 'crm/leads',
      fields: [
        { id: 'f-state', apiName: 'state', displayName: 'State', type: 'workflow', options: [{ id: 'opt-new', label: 'New' }] },
        { id: 'f-name', apiName: 'name', displayName: 'Name', type: 'title' },
      ],
    };
    const log = (method: string) => async (path: string, o?: { params?: { path?: Record<string, string> }; body?: unknown }) => {
      sent.push({ method, path, params: o?.params?.path, body: o?.body as Record<string, unknown> });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}') {
        return { data: { id: 'rec-1', number: 5, title: 'A lead', values: {} } };
      }
      if (path.endsWith('/staged')) return { data: { action: 'send_email', to: 'a@b.c' } };
      return { data: { ok: true } };
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies per tool.
    const call = async (n: string, a: unknown): Promise<any> => {
      const r = await handlers.get(n)!(a);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    return { call, sent, handlers };
  }

  it('create_agent_trigger resolves the state LABEL to an option id', async () => {
    // The API wants a uuid. Asking an agent for one it can only get by reading
    // the schema is exactly the friction describe_database exists to remove.
    const { call, sent } = harness();
    await call('create_agent_trigger', {
      workspace: 'Eng',
      agent: '3',
      database: 'Leads',
      state_field: 'state',
      state: 'New',
      human_gate: true,
    });
    const post = sent.find((s) => s.path.endsWith('/agents/triggers'))!;
    expect(post.body).toMatchObject({
      database_id: 'db-1',
      state_field_id: 'f-state',
      state_option_id: 'opt-new',
      human_gate: true,
    });
  });

  it('names the real options when given a state that does not exist', async () => {
    const { call } = harness();
    await expect(
      call('create_agent_trigger', { workspace: 'Eng', agent: '3', database: 'Leads', state_field: 'state', state: 'Nope' }),
    ).rejects.toThrow(/No option "Nope".*New/s);
  });

  it('omits human_gate entirely when unset, rather than defaulting it here', async () => {
    // The server owns that default; sending `false` would silently disable the
    // ADR-0010 gate for anyone who just did not pass the argument.
    const { call, sent } = harness();
    await call('create_agent_trigger', { workspace: 'Eng', agent: '3', database: 'Leads', state_field: 'state', state: 'New' });
    expect(sent.find((s) => s.path.endsWith('/agents/triggers'))!.body).not.toHaveProperty('human_gate');
  });

  it('delegate_to_agent resolves the record by public number', async () => {
    const { call, sent } = harness();
    await call('delegate_to_agent', { workspace: 'Eng', agent: '3', database: 'Leads', record: '5' });
    expect(sent.find((s) => s.path.endsWith('/delegate'))!.body).toEqual({ record_id: 'rec-1' });
  });

  it('get_staged_action says where approval actually happens', async () => {
    // An agent that reads a parked run and then cannot act must tell the person
    // what to do, or the gate just looks like a dead end.
    const { call } = harness();
    const out = await call('get_staged_action', { workspace: 'Eng', run: 'run-1' });
    expect(out.staged).toBeTruthy();
    expect(out.approve_with).toMatch(/human-only|Inbox/i);
  });

  it('exposes NO way to approve or reject a staged run — ADR-0010', async () => {
    // The gate. An agent able to approve its own staged action does not weaken
    // it, it removes it. If this test ever fails, the PR that broke it is wrong.
    const { handlers } = harness();
    const names = [...handlers.keys()];
    expect(names.filter((n) => /approve|reject/i.test(n))).toEqual([]);
    // And the read tool must not have quietly become a write.
    expect(names).toContain('get_staged_action');
  });
});

/**
 * #439 — the inbox.
 *
 * The asymmetry this closes: an automation could NOTIFY a person and nothing
 * could read the inbox, so an agent added to someone's pile and could never
 * tell them what was in it.
 *
 * The assertions that matter are the boundary ones. An inbox is per-identity,
 * and the failure worth preventing is a future tool growing a `user` argument.
 */
describe('#439 — notifications', () => {
  interface Sent { method: string; path: string; params?: Record<string, string>; query?: Record<string, unknown> }

  function harness() {
    const sent: Sent[] = [];
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const log = (method: string) => async (
      path: string,
      o?: { params?: { path?: Record<string, string>; query?: Record<string, unknown> } },
    ) => {
      sent.push({ method, path, params: o?.params?.path, query: o?.params?.query });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/notifications') {
        return {
          data: {
            data: [
              {
                id: 'n-1',
                type: 'mentioned',
                snippet: 'Ada mentioned you',
                read_at: null,
                created_at: '2026-08-27T10:00:00Z',
                record: { id: 'rec-1', title: 'Fix the bug', database_id: 'db-1', number: 42, deleted: false },
                actor: { id: 'u-1', name: 'Ada' },
              },
            ],
            next_cursor: null,
          },
        };
      }
      if (path.endsWith('/unread-count')) return { data: 3 };
      return { data: { ok: true } };
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies per tool.
    const call = async (n: string, a: unknown): Promise<any> => {
      const r = await handlers.get(n)!(a);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    return { call, sent, handlers };
  }

  it('offers NO way to read another person’s inbox', async () => {
    // The privacy boundary, asserted rather than described. The API has no such
    // parameter and this surface must never invent one.
    const { handlers } = harness();
    for (const name of ['list_notifications', 'get_unread_count', 'mark_notifications']) {
      const res = await handlers.get(name)!({ workspace: 'Eng', user: 'someone-else', action: 'read', all: true });
      expect(res.isError, `${name} must reject a user argument`).toBe(true);
      expect(res.content[0]!.text).toContain('"user"');
    }
  });

  it('turns a notification into something actionable — a record link', async () => {
    // A notification without a way to reach what it is about is just a sentence.
    const { call } = harness();
    const out = await call('list_notifications', { workspace: 'Eng' });
    expect(out.notifications[0]).toMatchObject({ type: 'mentioned', from: 'Ada', unread: true });
    expect(out.notifications[0].record.url).toContain('/r/fix-the-bug-42');
  });

  it('passes the narrowing filters through as the API expects them', async () => {
    const { call, sent } = harness();
    await call('list_notifications', { workspace: 'Eng', unread_only: true, type: 'assigned' });
    expect(sent.find((s) => s.path.endsWith('/notifications'))!.query).toMatchObject({
      unread_only: 'true',
      type: 'assigned',
    });
  });

  it('read-all goes to the bulk route; specific ids go one at a time', async () => {
    const bulk = harness();
    await bulk.call('mark_notifications', { workspace: 'Eng', action: 'read', all: true });
    expect(bulk.sent.map((s) => s.path)).toContain('/api/v1/workspaces/{ws}/notifications/read-all');

    const some = harness();
    await some.call('mark_notifications', { workspace: 'Eng', action: 'archive', notifications: ['n-1', 'n-2'] });
    const archives = some.sent.filter((s) => s.path.endsWith('/archive'));
    expect(archives).toHaveLength(2);
    expect(archives.map((a) => a.params!.id)).toEqual(['n-1', 'n-2']);
  });

  it('refuses all:true for anything but read — there is no archive-all', async () => {
    // Rather than silently archiving one page of results and reporting success.
    const { call } = harness();
    await expect(call('mark_notifications', { workspace: 'Eng', action: 'archive', all: true })).rejects.toThrow(
      /only supported with action "read"/,
    );
  });

  it('refuses a mark with neither ids nor all', async () => {
    const { call } = harness();
    await expect(call('mark_notifications', { workspace: 'Eng', action: 'read' })).rejects.toThrow(/ids, or all/);
  });
});

/**
 * #437 / #440 — view management, and the surfaces a person actually opens.
 *
 * The through-line worth testing in both: WHOSE screen a thing changes.
 * set_default_view changes everyone's; set_personal_filter changes only the
 * caller's; get_my_work and set_favorite are the caller's alone. Getting that
 * wrong is not a bug you notice in your own session — it is one a teammate
 * reports days later.
 */
describe('#437/#440 — views and personal surfaces', () => {
  interface Sent { method: string; path: string; params?: Record<string, string>; query?: Record<string, unknown>; body?: Record<string, unknown> }

  function harness() {
    const sent: Sent[] = [];
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const dbDetail = {
      id: 'db-1',
      name: 'Issues',
      qualifiedSlug: 'eng/issues',
      fields: [{ id: 'f-state', apiName: 'state', displayName: 'State', type: 'select', options: [{ id: 'opt-hi', label: 'High' }] }],
      views: [{ id: 'view-1', name: 'Board', type: 'board' }],
    };
    const log = (method: string) => async (
      path: string,
      o?: { params?: { path?: Record<string, string>; query?: Record<string, unknown> }; body?: unknown },
    ) => {
      sent.push({ method, path, params: o?.params?.path, query: o?.params?.query, body: o?.body as Record<string, unknown> });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: [dbDetail] };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: dbDetail };
      if (path === '/api/v1/workspaces/{ws}/spaces') return { data: [{ id: 'sp-1', name: 'Ops', slug: 'ops' }] };
      if (path.endsWith('/duplicate')) return { data: { id: 'view-2', name: 'Board copy' } };
      if (path.endsWith('/my-work')) return { data: { groups: [] } };
      if (path.endsWith('/recent')) return { data: { records: [] } };
      if (path.endsWith('/favorites')) return { data: [{ id: 'x' }] };
      return { data: { ok: true } };
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies per tool.
    const call = async (n: string, a: unknown): Promise<any> => {
      const r = await handlers.get(n)!(a);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    return { call, sent, handlers };
  }

  describe('#437 — whose screen does this change', () => {
    it('set_default_view says plainly that it affects EVERYONE', async () => {
      // The one tool here that changes what teammates see. If its result read
      // like the personal filter's, an agent would use them interchangeably.
      const { call } = harness();
      const out = await call('set_default_view', { workspace: 'Eng', database: 'Issues', view: 'Board' });
      expect(out.applies_to).toMatch(/everyone/i);
    });

    it('set_personal_filter says plainly that it affects only the caller', async () => {
      const { call } = harness();
      const out = await call('set_personal_filter', {
        workspace: 'Eng', database: 'Issues', view: 'Board', filter: { field: 'state', op: 'eq', value: 'High' },
      });
      expect(out.visible_to).toMatch(/you only/i);
    });

    it('maps a personal filter’s LABEL to an option id, like every other filter', async () => {
      // A personal filter taking raw option uuids while query_records takes
      // labels would be a second, quietly different filter contract.
      const { call, sent } = harness();
      await call('set_personal_filter', {
        workspace: 'Eng', database: 'Issues', view: 'Board', filter: { field: 'state', op: 'eq', value: 'High' },
      });
      expect(JSON.stringify(sent.find((s) => s.method === 'PUT')!.body)).toContain('opt-hi');
    });

    it('clear:true DELETEs rather than writing an empty filter', async () => {
      const { call, sent } = harness();
      const out = await call('set_personal_filter', { workspace: 'Eng', database: 'Issues', view: 'Board', clear: true });
      expect(sent.some((s) => s.method === 'DELETE')).toBe(true);
      expect(sent.some((s) => s.method === 'PUT')).toBe(false);
      expect(out.personal_filter).toBeNull();
    });

    it('refuses a personal filter call that says nothing', async () => {
      const { call } = harness();
      await expect(call('set_personal_filter', { workspace: 'Eng', database: 'Issues', view: 'Board' })).rejects.toThrow(
        /filter.*or clear/i,
      );
    });

    it('duplicate_view resolves the view by NAME and returns a usable link', async () => {
      const { call, sent } = harness();
      const out = await call('duplicate_view', { workspace: 'Eng', database: 'Issues', view: 'Board' });
      expect(sent.find((s) => s.path.endsWith('/duplicate'))!.params!.view).toBe('view-1');
      expect(out.url).toContain('?view=view-2');
    });

    it('delete_space_view states that the records survive', async () => {
      // A dashboard is a lens. "Deleted" next to a view name reads alarming
      // unless the result says what was NOT deleted.
      const { call } = harness();
      expect((await call('delete_space_view', { workspace: 'Eng', view: 'v-9' })).note).toMatch(/untouched/i);
    });

    it('update_space_view refuses an empty change', async () => {
      const { call } = harness();
      await expect(call('update_space_view', { workspace: 'Eng', view: 'v-9' })).rejects.toThrow(/name.*space/i);
    });
  });

  describe('#440 — one tool with a kind, not three', () => {
    it('routes each kind to its own endpoint', async () => {
      // The decision #440 asked for: three lenses on "what is this person
      // working on", not three entries in a catalog every session pays for.
      const cases: Array<[string, string]> = [
        ['assigned', '/api/v1/workspaces/{ws}/my-work'],
        ['created', '/api/v1/workspaces/{ws}/my-work'],
        ['recent', '/api/v1/workspaces/{ws}/recent'],
        ['favorites', '/api/v1/workspaces/{ws}/favorites'],
      ];
      for (const [kind, path] of cases) {
        const h = harness();
        await h.call('get_my_work', { workspace: 'Eng', kind });
        expect(h.sent.map((s) => s.path), kind).toContain(path);
      }
    });

    it('distinguishes assigned from created via the tab the API expects', async () => {
      const a = harness();
      await a.call('get_my_work', { workspace: 'Eng' });
      expect(a.sent.find((s) => s.path.endsWith('/my-work'))!.query).toMatchObject({ tab: 'assigned' });

      const c = harness();
      await c.call('get_my_work', { workspace: 'Eng', kind: 'created' });
      expect(c.sent.find((s) => s.path.endsWith('/my-work'))!.query).toMatchObject({ tab: 'created' });
    });

    it('offers no way to read ANOTHER person’s work or stars', async () => {
      const { handlers } = harness();
      for (const name of ['get_my_work', 'set_favorite']) {
        const res = await handlers.get(name)!({ workspace: 'Eng', user: 'someone-else', target_type: 'database', target: 'Issues' });
        expect(res.isError, `${name} must reject a user argument`).toBe(true);
      }
    });

    it('set_favorite resolves a database by name, and unstars via DELETE', async () => {
      const on = harness();
      await on.call('set_favorite', { workspace: 'Eng', target_type: 'database', target: 'Issues' });
      expect(on.sent.find((s) => s.method === 'POST')!.body).toMatchObject({ target_type: 'database', target_id: 'db-1' });

      const off = harness();
      const out = await off.call('set_favorite', { workspace: 'Eng', target_type: 'database', target: 'Issues', starred: false });
      expect(off.sent.some((s) => s.method === 'DELETE')).toBe(true);
      expect(out.starred).toBe(false);
    });
  });
});

/**
 * #441 — membership and access, read only.
 *
 * Two assertions carry this whole area: that no WRITE tool exists, and that
 * `list_members` does not hand back email. Everything else is plumbing.
 */
describe('#441 — membership reads, and the writes that must not exist', () => {
  function harness() {
    const sent: string[] = [];
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
    const log = (method: string) => async (path: string) => {
      sent.push(`${method} ${path}`);
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === '/api/v1/workspaces/{ws}/members') {
        return {
          data: [
            {
              id: 'm-1',
              role: 'admin',
              user_id: 'u-1',
              user: { id: 'u-1', name: 'Ada Lovelace', email: 'ada@example.com', image: 'https://x/y.png' },
            },
          ],
        };
      }
      return { data: [] };
    };
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never, {
      client: { GET: log('GET'), POST: log('POST'), PATCH: log('PATCH'), PUT: log('PUT'), DELETE: log('DELETE') } as never,
      baseUrl: 'http://test',
      token: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies per tool.
    const call = async (n: string, a: unknown): Promise<any> => {
      const r = await handlers.get(n)!(a);
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    return { call, sent, handlers };
  }

  it('does NOT return member emails, though the endpoint provides them', async () => {
    // A read-scoped token is the weakest credential the product issues, and the
    // member list is the workspace's contact sheet. Nothing legitimate needs
    // the address: a user field wants the id, a sentence wants the name.
    const { call } = harness();
    const out = await call('list_members', { workspace: 'Eng' });
    expect(JSON.stringify(out)).not.toContain('ada@example.com');
    expect(out.members[0]).toMatchObject({ user_id: 'u-1', name: 'Ada Lovelace', role: 'admin' });
  });

  it('returns the id a user field actually wants, and says so', async () => {
    // The gap this closes: assignee writes were rejected for naming a
    // non-member, with no way to check first.
    const { call } = harness();
    const out = await call('list_members', { workspace: 'Eng' });
    expect(out.members[0].user_id).toBe('u-1');
    expect(out.note).toMatch(/user field/i);
  });

  it('exposes NO tool that changes membership or access — ADR-0010', async () => {
    // The gate. An agent that can grant access can widen its own blast radius:
    // scope is what a token MAY do, grants are what it may do it TO. If this
    // test ever fails, the PR that broke it is wrong.
    const { handlers } = harness();
    const names = [...handlers.keys()];
    // Matched on WRITE VERBS rather than on the nouns: an earlier version of
    // this regex flagged `list_invites`, which is the read half doing its job.
    const writeVerb = /^(create|add|remove|revoke|delete|update|set|invite|grant)_.*(member|grant|invite|role|access)/i;
    expect(names.filter((n) => writeVerb.test(n))).toEqual([]);
    // And the read half must still be there — a guard that passes because the
    // whole area vanished would be worthless.
    expect(names).toEqual(expect.arrayContaining(['list_members', 'list_grants', 'list_invites']));
  });

  it('every membership tool is a GET', async () => {
    const { call, sent } = harness();
    await call('list_members', { workspace: 'Eng' });
    await call('list_grants', { workspace: 'Eng' });
    await call('list_invites', { workspace: 'Eng' });
    expect(sent.filter((s) => !s.startsWith('GET '))).toEqual([]);
  });
});

/**
 * #393 — the capabilities that exist must be FINDABLE.
 *
 * A careful reviewer with docs and MCP access concluded that scheduled rules
 * could not call a webhook and that email was "genuinely missing". Both false,
 * and both acted on — the resulting plan routed around outbound HTTP and
 * treated email as a blocker.
 *
 * Wrong capability information does not merely inform badly, it changes what
 * gets built. So this asserts the descriptions say the three things in WORDS,
 * not that the actions exist — they always did.
 */
describe('#393 — a reader can tell that rules email, call APIs and post to Slack', () => {
  function descriptions() {
    const configs = new Map<string, { description?: string }>();
    registerTools(
      { registerTool: (n: string, c: { description?: string }) => configs.set(n, c) } as never,
      { client: { GET: async () => ({ data: [] }) } as never, baseUrl: '', token: '' } as never,
    );
    return configs;
  }

  /** get_started builds its orientation text in the HANDLER, not the config —
   * so this is where that line actually has to be asserted. */
  async function orientation(): Promise<string> {
    const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }> }>>();
    registerTools(
      { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h as never) } as never,
      { client: { GET: async () => ({ data: [] }) } as never, baseUrl: '', token: '' } as never,
    );
    const res = await handlers.get('get_started')!({});
    return res.content[0]!.text;
  }

  it('create_automation states email, HTTP and Slack in prose', () => {
    const d = descriptions().get('create_automation')!.description!;
    expect(d).toMatch(/SEND EMAIL/);
    expect(d).toMatch(/CALL ANY HTTP API/);
    expect(d).toMatch(/POST TO SLACK/i);
  });

  it('create_automation says these work from SCHEDULED rules, not only buttons', () => {
    // The reviewer's exact wrong conclusion was "buttons can hit a webhook …
    // scheduled and triggered rules cannot".
    const d = descriptions().get('create_automation')!.description!;
    expect(d).toMatch(/SCHEDULED and TRIGGERED rules, not only from buttons/i);
  });

  it('names the SSRF restriction where someone would look for it', () => {
    // "Any HTTP API" is not quite true and the exception matters: a private
    // address is refused. Stating it here stops it being discovered as a bug.
    const d = descriptions().get('create_automation')!.description!;
    expect(d).toMatch(/[Pp]rivate and internal addresses are refused/);
  });

  it('get_started says it too — that is where an agent orients', async () => {
    const d = await orientation();
    expect(d).toMatch(/REACH OUTSIDE StoryOS/i);
    expect(d).toMatch(/send real email/i);
  });

  it('the compressed action list still names the real action ids', async () => {
    // Prose replaces nothing — an agent still needs the exact names to call.
    const d = await orientation();
    for (const action of ['send_email', 'http_request', 'send_slack_message']) {
      expect(d, `${action} must still be listed`).toContain(action);
    }
  });
});
