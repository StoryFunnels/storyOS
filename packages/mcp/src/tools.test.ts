import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setIconName } from '@storyos/schemas/icons';
import { buildIconCatalog, ICON_PARAM_DESCRIPTION, mapFilterValues, registerTools } from './tools.js';

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
