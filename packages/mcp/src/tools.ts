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
  spaceSlug?: string | null;
  qualifiedSlug?: string;
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
      const map = {
        workspace: { id: ws.id, name: ws.name },
        databases: dbs.map((d) => ({ id: d.id, name: d.name, ref: d.qualifiedSlug ?? d.apiSlug, space: d.spaceSlug ?? null })),
      };
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
      description:
        'Databases in a workspace. `ref` is the canonical space/database slug — use it (not the bare name) to target a database unambiguously, since the same name can exist in two spaces.',
      inputSchema: { workspace: z.string().describe('Workspace name or id.') },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const dbs = await listDatabases(client, ws.id);
      return text(
        dbs.map((d) => ({ id: d.id, name: d.name, ref: d.qualifiedSlug ?? d.apiSlug, space: d.spaceSlug ?? null })),
      );
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
        ref: detail.qualifiedSlug ?? undefined,
        space: detail.spaceSlug ?? undefined,
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

  // ============ Schema building (MN-146): databases, fields, views ============

  async function resolveSpaceId(wsId: string, ref: string): Promise<string> {
    const spaces = await unwrap<Array<{ id: string; name: string }>>(
      client.GET('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws: wsId } as never } }),
    );
    const lower = ref.trim().toLowerCase();
    const s = spaces.find((x) => x.id === ref || x.name.toLowerCase() === lower);
    if (!s) throw new Error(`No space matches "${ref}". Available: ${spaces.map((x) => x.name).join(', ') || '(none)'}.`);
    return s.id;
  }

  /** Resolve any field by name/api_name/id (no type filter). */
  const anyField = (detail: DatabaseDetail, ref: string): string => {
    const lower = ref.trim().toLowerCase();
    const f = detail.fields.find(
      (x) => x.id === ref || x.apiName.toLowerCase() === lower || x.displayName.toLowerCase() === lower,
    );
    if (!f) throw new Error(`No field matches "${ref}". Available: ${detail.fields.map((x) => x.apiName).join(', ')}.`);
    return f.id;
  };

  const resolveView = (detail: DatabaseDetail, ref: string) => {
    const lower = ref.trim().toLowerCase();
    const v = (detail.views ?? []).find((x) => x.id === ref || x.name.toLowerCase() === lower);
    if (!v) throw new Error(`No view matches "${ref}". Available: ${(detail.views ?? []).map((x) => x.name).join(', ') || '(none)'}.`);
    return v;
  };

  server.registerTool(
    'create_database',
    {
      title: 'Create database',
      description:
        'Create a new database (table) in a space. Returns it with its auto-created system fields (id, name). Then shape it with add_field and create_view.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().describe('Space name or id the database belongs to.'),
        name: z.string().describe('Database name, e.g. "Clients".'),
        icon: z.string().optional().describe('An emoji, e.g. "📁".'),
      },
    },
    handle<{ workspace: string; space: string; name: string; icon?: string }>(async ({ workspace, space, name, icon }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const db = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/databases', {
          params: { path: { ws: ws.id } as never },
          body: { space_id: spaceId, name, icon } as never,
        }),
      );
      return text(db);
    }),
  );

  const FIELD_TYPES = [
    'text', 'rich_text', 'number', 'checkbox', 'date', 'select', 'multi_select',
    'url', 'email', 'user', 'lookup', 'rollup', 'button', 'formula',
  ] as const;
  const optionShape = z.union([z.string(), z.object({ label: z.string(), color: z.string().optional() })]);
  const normOptions = (o?: Array<string | { label: string; color?: string }>) =>
    o?.map((x) => (typeof x === 'string' ? { label: x } : x));

  server.registerTool(
    'add_field',
    {
      title: 'Add field',
      description:
        'Add a field to a database. For select/multi_select pass options as labels. lookup/rollup/formula need config. (Relations link two databases — not added here yet.) Returns the field.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        name: z.string().describe('Field name, e.g. "Status".'),
        type: z.enum(FIELD_TYPES),
        options: z.array(optionShape).optional().describe('select/multi_select choices, as labels or {label,color}.'),
        config: z.record(z.string(), z.any()).optional().describe('Advanced per-type config (lookup/rollup/formula).'),
      },
    },
    handle<{ workspace: string; database: string; name: string; type: string; options?: Array<string | { label: string; color?: string }>; config?: Record<string, unknown> }>(
      async ({ workspace, database, name, type, options, config }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const field = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/fields', {
            params: { path: { ws: ws.id, db: db.id } },
            body: { display_name: name, type, options: normOptions(options), config } as never,
          }),
        );
        return text(field);
      },
    ),
  );

  server.registerTool(
    'update_field',
    {
      title: 'Update field',
      description: 'Rename a field and/or add new select options. Returns the updated field.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        field: z.string().describe('Field to update (name, api_name, or id).'),
        rename_to: z.string().optional(),
        add_options: z.array(optionShape).optional().describe('New choices to add to a select/multi_select field.'),
      },
    },
    handle<{ workspace: string; database: string; field: string; rename_to?: string; add_options?: Array<string | { label: string; color?: string }> }>(
      async ({ workspace, database, field, rename_to, add_options }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const fieldId = anyField(detail, field);
        if (rename_to) {
          await unwrap<unknown>(
            client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
              params: { path: { ws: ws.id, db: db.id, field: fieldId } } as never,
              body: { display_name: rename_to } as never,
            }),
          );
        }
        for (const o of normOptions(add_options) ?? []) {
          await unwrap<unknown>(
            client.POST('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options', {
              params: { path: { ws: ws.id, db: db.id, field: fieldId } } as never,
              body: o as never,
            }),
          );
        }
        const updated = await getDetail(ws.id, db.id);
        return text(updated.fields.find((f) => f.id === fieldId));
      },
    ),
  );

  server.registerTool(
    'delete_field',
    {
      title: 'Delete field',
      description: 'Soft-delete a field (records keep their other values). Returns records_with_value.',
      inputSchema: { workspace: z.string(), database: z.string(), field: z.string() },
    },
    handle<{ workspace: string; database: string; field: string }>(async ({ workspace, database, field }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const fieldId = anyField(detail, field);
      const res = await unwrap<unknown>(
        client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
          params: { path: { ws: ws.id, db: db.id, field: fieldId } } as never,
        }),
      );
      return text(res);
    }),
  );

  const VIEW_TYPES = ['table', 'board', 'calendar', 'gallery', 'list', 'feed', 'timeline', 'form'] as const;
  type ViewOpts = { group_by?: string; card_fields?: string[]; date_field?: string; start_date_field?: string; end_date_field?: string };
  function buildViewConfig(detail: DatabaseDetail, type: string, o: ViewOpts): Record<string, unknown> {
    const config: Record<string, unknown> = { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };
    if (o.card_fields) config.card_field_ids = o.card_fields.map((f) => anyField(detail, f));
    if (type === 'board' && o.group_by) config.group_by_field_id = anyField(detail, o.group_by);
    if (type === 'calendar' && o.date_field) config.date_field_id = anyField(detail, o.date_field);
    if (type === 'timeline') {
      if (o.start_date_field) config.start_date_field_id = anyField(detail, o.start_date_field);
      if (o.end_date_field) config.end_date_field_id = anyField(detail, o.end_date_field);
    }
    return config;
  }

  server.registerTool(
    'create_view',
    {
      title: 'Create view',
      description:
        'Create a saved view. board needs group_by (a select field); calendar needs date_field; timeline needs start_date_field/end_date_field; board/gallery/list show card_fields (chips on calendar).',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        name: z.string(),
        type: z.enum(VIEW_TYPES),
        group_by: z.string().optional().describe('board: single-select field to group columns by.'),
        card_fields: z.array(z.string()).optional().describe('Fields shown on cards / chips.'),
        date_field: z.string().optional().describe('calendar: the date field.'),
        start_date_field: z.string().optional().describe('timeline: start date field.'),
        end_date_field: z.string().optional().describe('timeline: end date field.'),
      },
    },
    handle<{ workspace: string; database: string; name: string; type: string } & ViewOpts>(
      async ({ workspace, database, name, type, ...rest }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const view = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/views', {
            params: { path: { ws: ws.id, db: db.id } },
            body: { name, type, config: buildViewConfig(detail, type, rest) } as never,
          }),
        );
        return text(view);
      },
    ),
  );

  server.registerTool(
    'update_view',
    {
      title: 'Update view',
      description: 'Rename a view or change its grouping / card fields / date fields. Only the parts you pass change.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        view: z.string().describe('View name or id.'),
        rename_to: z.string().optional(),
        group_by: z.string().optional(),
        card_fields: z.array(z.string()).optional(),
        date_field: z.string().optional(),
        start_date_field: z.string().optional(),
        end_date_field: z.string().optional(),
      },
    },
    handle<{ workspace: string; database: string; view: string; rename_to?: string } & ViewOpts>(
      async ({ workspace, database, view, rename_to, ...rest }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const v = resolveView(detail, view);
        const patch: Record<string, unknown> = {};
        if (rename_to) patch.name = rename_to;
        if ((['group_by', 'card_fields', 'date_field', 'start_date_field', 'end_date_field'] as const).some((k) => rest[k] !== undefined)) {
          patch.config = buildViewConfig(detail, v.type, rest);
        }
        const updated = await unwrap<unknown>(
          client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
            params: { path: { ws: ws.id, db: db.id, view: v.id } } as never,
            body: patch as never,
          }),
        );
        return text(updated);
      },
    ),
  );

  server.registerTool(
    'delete_view',
    {
      title: 'Delete view',
      description: 'Delete a view (409 if it is the last view on the database).',
      inputSchema: { workspace: z.string(), database: z.string(), view: z.string() },
    },
    handle<{ workspace: string; database: string; view: string }>(async ({ workspace, database, view }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const v = resolveView(detail, view);
      const res = await unwrap<unknown>(
        client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
          params: { path: { ws: ws.id, db: db.id, view: v.id } } as never,
        }),
      );
      return text(res);
    }),
  );

  // ============ Relations (MN-146 fast-follow): link databases ============

  server.registerTool(
    'create_relation',
    {
      title: 'Create relation',
      description:
        'Link two databases with a relation field on each side. one_to_many: each record in `database` links to ONE record in `related_database`, and each related record gets MANY back — e.g. database=Tasks, related_database=Projects means each task has one project and each project has many tasks. many_to_many: both sides link to many. Use the space/database form for names that exist in more than one space.',
      inputSchema: {
        workspace: z.string(),
        database: z.string().describe('The "many" side for one_to_many (e.g. tasks).'),
        related_database: z.string().describe('The "one" / parent side (e.g. projects).'),
        type: z.enum(['one_to_many', 'many_to_many']).default('one_to_many'),
        field_name: z.string().optional().describe('Relation field name on `database` (default: the related database name).'),
        reverse_field_name: z.string().optional().describe('Inverse field name on `related_database` (default: this database name).'),
      },
    },
    handle<{ workspace: string; database: string; related_database: string; type?: string; field_name?: string; reverse_field_name?: string }>(
      async ({ workspace, database, related_database, type, field_name, reverse_field_name }) => {
        const ws = await resolveWorkspace(client, workspace);
        const a = await resolveDatabase(client, ws.id, database); // "many" side (A)
        const b = await resolveDatabase(client, ws.id, related_database); // "one" side (B)
        const rel = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/relations', {
            params: { path: { ws: ws.id } as never },
            body: {
              database_a_id: a.id,
              database_b_id: b.id,
              cardinality: type ?? 'one_to_many',
              ...(field_name ? { field_a_name: field_name } : {}),
              ...(reverse_field_name ? { field_b_name: reverse_field_name } : {}),
            } as never,
          }),
        );
        return text(rel);
      },
    ),
  );

  server.registerTool(
    'delete_relation',
    {
      title: 'Delete relation',
      description: 'Delete a relation by its id (from a describe_database relation field or a prior create_relation), removing both fields and all links.',
      inputSchema: { workspace: z.string(), relation_id: z.string() },
    },
    handle<{ workspace: string; relation_id: string }>(async ({ workspace, relation_id }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.DELETE('/api/v1/workspaces/{ws}/relations/{rel}', {
          params: { path: { ws: ws.id, rel: relation_id } } as never,
          body: { confirm: true } as never,
        }),
      );
      return text(res);
    }),
  );
}
