import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from './client.js';
import { unwrap } from './client.js';
import { listDatabases, listWorkspaces, resolveDatabase, resolveWorkspace } from './resolve.js';

/** MCP text result. */
function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

/** Wrap a handler so any error (incl. the API's typed 422) is returned to the model
 * as an isError result — validation-as-teacher, so it self-corrects in one turn. */
function handle<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  };
}

interface FieldDef {
  id: string;
  apiName: string;
  displayName: string;
  type: string;
  isSystem?: boolean;
  options?: Array<{ id: string; label: string; color?: string }>;
  relation?: { target_database_id: string; target_database_name: string | null; cardinality: string; side: string };
}
interface DatabaseDetail {
  id: string;
  name: string;
  my_access?: string;
  fields: FieldDef[];
  views?: Array<{ id: string; name: string; type: string }>;
}
interface RecordRow {
  id: string;
  number: number | null;
  title: string;
  values: Record<string, unknown>;
}

const FILTER_GUIDE = `Filtering uses a structured AST (never free text):
  filter = { "and": [ <condition>, ... ] }   // or "or"; conditions nest
  condition = { "field": "<api_name>", "op": "<operator>", "value": <value> }
Operators by field type (call describe_database for exact api_names; the server
validates and returns a typed error naming any mismatch):
  text/url/email : eq, neq, contains, starts_with, is_empty, not_empty
  number/id/date : eq, neq, gt, gte, lt, lte, is_empty, not_empty
  select         : eq, neq, is_empty, not_empty        (value = option label or id)
  multi_select   : has, has_none                        (value = [labels or ids])
  user           : has, has_none                        (value = ["@me"] or user ids)
  relation       : has, has_none                        (value = [record ids])
  checkbox       : eq                                    (value = true | false)
Dates accept ISO strings or relative tokens; user filters accept "@me".`;

function describeFields(db: DatabaseDetail) {
  return db.fields
    .filter((f) => !['created_at', 'updated_at', 'created_by'].includes(f.type))
    .map((f) => {
      const out: Record<string, unknown> = { api_name: f.apiName, name: f.displayName, type: f.type };
      if (f.isSystem) out.read_only = true;
      if (f.options?.length) out.options = f.options.map((o) => ({ label: o.label, color: o.color }));
      if (f.relation) out.links_to = f.relation.target_database_name ?? f.relation.target_database_id;
      return out;
    });
}

/** Register the Phase-1 (read-only) tool catalog (MN-076). */
export function registerTools(server: McpServer, client: Client) {
  server.registerTool(
    'get_started',
    {
      title: 'Get started',
      description:
        'Orientation for these tools + a map of a workspace (spaces → databases → fields) + the filter cheat-sheet. Call this first when working in a new workspace.',
      inputSchema: { workspace: z.string().optional().describe('Workspace name or id to map (optional).') },
    },
    handle<{ workspace?: string }>(async ({ workspace }) => {
      const intro = [
        'StoryOS MCP — read a workspace of user-defined relational databases.',
        '',
        'Flow: list_workspaces → list_databases → describe_database (READ THE SCHEMA before querying) → query_records / search / get_record.',
        'Never invent ids: they come only from search / list_* / a prior result. Names and slugs are accepted and resolved server-side.',
        '',
        FILTER_GUIDE,
      ].join('\n');
      if (!workspace) return text(intro);
      const ws = await resolveWorkspace(client, workspace);
      const dbs = await listDatabases(client, ws.id);
      const map = { workspace: { id: ws.id, name: ws.name }, databases: dbs.map((d) => ({ id: d.id, name: d.name })) };
      return text(`${intro}\n\nWorkspace map:\n${JSON.stringify(map, null, 2)}`);
    }),
  );

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: 'Every workspace the token can access (id, name, role).',
      inputSchema: {},
    },
    handle<Record<string, never>>(async () => text(await listWorkspaces(client))),
  );

  server.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description: 'Databases in a workspace (id, name, api slug). Group these by space if needed.',
      inputSchema: { workspace: z.string().describe('Workspace name or id.') },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const dbs = await listDatabases(client, ws.id);
      return text(dbs.map((d) => ({ id: d.id, name: d.name, api_slug: d.apiSlug })));
    }),
  );

  server.registerTool(
    'describe_database',
    {
      title: 'Describe database',
      description:
        'The schema of one database: every field with its exact api_name, type, select options and relation targets. READ THIS before create/query so you use real api_names, not guesses.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
      },
    },
    handle<{ workspace: string; database: string }>(async ({ workspace, database }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await unwrap<DatabaseDetail>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}', { params: { path: { ws: ws.id, db: db.id } } }),
      );
      return text({
        id: detail.id,
        name: detail.name,
        my_access: detail.my_access,
        fields: describeFields(detail),
        views: (detail.views ?? []).map((v) => ({ name: v.name, type: v.type })),
      });
    }),
  );

  server.registerTool(
    'search',
    {
      title: 'Search records',
      description: 'Full-text search records across a workspace by title. Use this to turn a name ("the Acme project") into a real record id.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        query: z.string().describe('Text to search for.'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    handle<{ workspace: string; query: string; limit?: number }>(async ({ workspace, query, limit }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<{ records?: Array<{ id: string; title: string; database_id: string; database_name?: string }> }>(
        client.GET('/api/v1/workspaces/{ws}/search', { params: { path: { ws: ws.id }, query: { q: query } } as never }),
      );
      const hits = (res.records ?? []).slice(0, limit ?? 20);
      return text(hits.map((h) => ({ id: h.id, title: h.title, database: h.database_name, database_id: h.database_id })));
    }),
  );

  server.registerTool(
    'query_records',
    {
      title: 'Query records',
      description:
        'List/filter/sort records in a database. filter is the structured AST (see get_started). Returns compact records + next_cursor for pagination.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        filter: z.any().optional().describe('Filter AST: { and: [{ field, op, value }] } — see get_started.'),
        sorts: z
          .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }))
          .optional()
          .describe('Sort keys by field api_name.'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe('next_cursor from a prior call.'),
      },
    },
    handle<{ workspace: string; database: string; filter?: unknown; sorts?: unknown; limit?: number; cursor?: string }>(
      async ({ workspace, database, filter, sorts, limit, cursor }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const res = await unwrap<{ data: RecordRow[]; next_cursor: string | null; has_more: boolean }>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
            params: { path: { ws: ws.id, db: db.id } },
            body: { filter, sorts: sorts ?? [], limit: limit ?? 50, cursor } as never,
          }),
        );
        return text({
          records: res.data.map((r) => ({ id: r.id, number: r.number, title: r.title, values: r.values })),
          next_cursor: res.next_cursor,
          has_more: res.has_more,
        });
      },
    ),
  );

  server.registerTool(
    'get_record',
    {
      title: 'Get record',
      description: 'One record in full — values keyed by api_name, resolved relation chips. Accepts the record uuid or its public number.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        record: z.string().describe('Record uuid or public number (e.g. "17").'),
      },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const isNumber = /^\d+$/.test(record.trim());
      const row = isNumber
        ? await unwrap<RecordRow>(
            client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}', {
              params: { path: { ws: ws.id, db: db.id, number: record.trim() } } as never,
            }),
          )
        : await unwrap<RecordRow>(
            client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
              params: { path: { ws: ws.id, db: db.id, rec: record } },
            }),
          );
      return text(row);
    }),
  );

  // ---- Phase 2: writes (MN-076). Each returns the resulting record (read-back);
  // the API's typed 422 is surfaced verbatim so the model self-corrects. ----

  const getDetail = (wsId: string, dbId: string) =>
    unwrap<DatabaseDetail>(
      client.GET('/api/v1/workspaces/{ws}/databases/{db}', { params: { path: { ws: wsId, db: dbId } } }),
    );

  /** Label-friendly writes (MN-076): map select/multi-select values given as human
   * labels to their option ids, so the model writes "High", not a UUID. */
  function mapSelectLabels(detail: DatabaseDetail, values: Record<string, unknown>): Record<string, unknown> {
    const byApi = new Map(detail.fields.map((f) => [f.apiName, f]));
    const out: Record<string, unknown> = { ...values };
    for (const [key, value] of Object.entries(values)) {
      const f = byApi.get(key);
      if (!f?.options?.length) continue;
      const toId = (v: unknown) => {
        const o = f.options!.find((x) => x.id === v || x.label.toLowerCase() === String(v).toLowerCase());
        return o ? o.id : v;
      };
      if (f.type === 'select' && typeof value === 'string') out[key] = toId(value);
      else if (f.type === 'multi_select' && Array.isArray(value)) out[key] = value.map(toId);
    }
    return out;
  }

  async function resolveRecordId(wsId: string, dbId: string, ref: string): Promise<string> {
    if (!/^\d+$/.test(ref.trim())) return ref;
    const row = await unwrap<RecordRow>(
      client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/by-number/{number}', {
        params: { path: { ws: wsId, db: dbId, number: ref.trim() } } as never,
      }),
    );
    return row.id;
  }

  function resolveFieldId(detail: DatabaseDetail, ref: string, types: string[], kind: string): string {
    const lower = ref.trim().toLowerCase();
    const f = detail.fields.find(
      (x) => (x.id === ref || x.apiName.toLowerCase() === lower || x.displayName.toLowerCase() === lower) && types.includes(x.type),
    );
    if (!f) {
      const avail = detail.fields.filter((x) => types.includes(x.type)).map((x) => x.apiName);
      throw new Error(`No ${kind} field matches "${ref}". Available: ${avail.join(', ') || '(none)'}.`);
    }
    return f.id;
  }

  server.registerTool(
    'create_record',
    {
      title: 'Create record',
      description:
        'Create a record. values are keyed by api_name (call describe_database first); select/person values accept the human label. Returns the created record.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        values: z.record(z.string(), z.any()).describe('Field values by api_name; "name" sets the title.'),
      },
    },
    handle<{ workspace: string; database: string; values: Record<string, unknown> }>(async ({ workspace, database, values }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const row = await unwrap<RecordRow>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
          params: { path: { ws: ws.id, db: db.id } },
          body: { values: mapSelectLabels(detail, values) } as never,
        }),
      );
      return text(row);
    }),
  );

  server.registerTool(
    'update_record',
    {
      title: 'Update record',
      description: 'Merge-update a record (null clears a field). values by api_name; record is a uuid or public number. Returns the updated record.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string(),
        values: z.record(z.string(), z.any()),
      },
    },
    handle<{ workspace: string; database: string; record: string; values: Record<string, unknown> }>(
      async ({ workspace, database, record, values }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const row = await unwrap<RecordRow>(
          client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
            params: { path: { ws: ws.id, db: db.id, rec } },
            body: { values: mapSelectLabels(detail, values) } as never,
          }),
        );
        return text(row);
      },
    ),
  );

  server.registerTool(
    'delete_record',
    {
      title: 'Delete record',
      description: 'Move a record to trash (restorable 30 days). record is a uuid or public number.',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string() },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      await unwrap(
        client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', { params: { path: { ws: ws.id, db: db.id, rec } } }),
      );
      return text({ deleted: rec });
    }),
  );

  server.registerTool(
    'link_records',
    {
      title: 'Link records',
      description:
        'Add links from a record through a relation field to target records (by uuid or public number). Get target ids from search / query_records first.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string(),
        relation_field: z.string().describe('The relation field on this database (api_name, name, or id).'),
        targets: z.array(z.string()).describe('Target record uuids or public numbers.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; relation_field: string; targets: string[] }>(
      async ({ workspace, database, record, relation_field, targets }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const fieldId = resolveFieldId(detail, relation_field, ['relation'], 'relation');
        const rec = await resolveRecordId(ws.id, db.id, record);
        const relField = detail.fields.find((f) => f.id === fieldId);
        const targetDbId = relField?.relation?.target_database_id ?? db.id;
        const targetIds = await Promise.all(targets.map((t) => resolveRecordId(ws.id, targetDbId, t)));
        await unwrap(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}', {
            params: { path: { ws: ws.id, db: db.id, rec, field: fieldId } } as never,
            body: { record_ids: targetIds } as never,
          }),
        );
        const row = await unwrap<RecordRow>(
          client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', { params: { path: { ws: ws.id, db: db.id, rec } } }),
        );
        return text(row);
      },
    ),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description: 'Post a plain-text comment on a record (uuid or public number).',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string(), body: z.string() },
    },
    handle<{ workspace: string; database: string; record: string; body: string }>(async ({ workspace, database, record, body }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      await unwrap(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments', {
          params: { path: { ws: ws.id, db: db.id, rec } },
          body: { body: [{ type: 'text', text: body }] } as never,
        }),
      );
      return text({ commented_on: rec });
    }),
  );

  server.registerTool(
    'run_button',
    {
      title: 'Run button',
      description: 'Press a button field on a record, running its configured actions (set values / create linked / comment / notify / update linked).',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string(),
        button: z.string().describe('The button field (api_name, name, or id).'),
      },
    },
    handle<{ workspace: string; database: string; record: string; button: string }>(async ({ workspace, database, record, button }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const fieldId = resolveFieldId(detail, button, ['button'], 'button');
      const rec = await resolveRecordId(ws.id, db.id, record);
      const res = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/buttons/{field}/press', {
          params: { path: { ws: ws.id, db: db.id, rec, field: fieldId } } as never,
        }),
      );
      return text(res);
    }),
  );
}
