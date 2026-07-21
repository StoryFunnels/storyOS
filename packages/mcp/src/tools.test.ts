import { describe, expect, it } from 'vitest';
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
