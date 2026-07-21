import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx, EffectiveScope, ToolScope } from './client.js';
import { unwrap, uploadAttachment } from './client.js';
// Subpath, not the barrel: markdown/icons are zod-free, and pulling the whole
// schemas index into this ESM bundle inlines a CJS require('zod') that throws
// at boot.
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas/markdown';
import { ICON_CATEGORIES, ICON_SET_META, ICON_SET_PREFIX } from '@storyos/schemas/icons';
import { listDatabases, listWorkspaces, resolveDatabase, resolveWorkspace } from './resolve.js';
import { databaseUrl, recordUrl, viewUrl } from './links.js';

/** Icon param description shared by create_database/update_database/create_space
 * (#251: emoji retired as the picker option in-app; the MCP surface keeps
 * accepting it for back-compat but no longer advertises it as the default). */
export const ICON_PARAM_DESCRIPTION =
  'A curated icon ref, e.g. "set:rocket" — call list_icon_set for the full catalog. ' +
  'A raw emoji (e.g. "📁") still works for backward compatibility with older data, but is not the preferred form.';

/** Curated icon names grouped by category label, for the list_icon_set tool
 * (#251). Exported standalone (like mapFilterValues below) so it's testable
 * without registering a full McpServer. */
export function buildIconCatalog(): { prefix: string; categories: Record<string, string[]> } {
  const byCategory: Record<string, string[]> = {};
  for (const cat of ICON_CATEGORIES) byCategory[cat.label] = [];
  for (const icon of ICON_SET_META) {
    for (const catId of icon.categories) {
      const label = ICON_CATEGORIES.find((c) => c.id === catId)?.label ?? catId;
      (byCategory[label] ??= []).push(icon.name);
    }
  }
  return { prefix: ICON_SET_PREFIX, categories: byCategory };
}

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
Dates accept ISO strings or relative tokens; user filters accept "@me".
eq/neq on a select or person are accepted and mapped to has/has_none for you.
Example: { "and": [{ "field": "priority", "op": "eq", "value": "Urgent" }] }`;

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

/**
 * Resolve select/multi_select FILTER values from human labels → option ids (#77).
 *
 * get_started promises "select labels are resolved server-side", and writes already
 * do this via mapSelectLabels — but filters didn't, so the API (which validates
 * option ids) rejected `{field:'state', op:'eq', value:'Done'}` with an opaque
 * "unknown option id". Every realistic agent filter is on a select, which is why
 * filtering looked completely broken. Unknown labels raise a helpful error naming
 * the valid options instead of failing at the API.
 */
export function mapFilterValues(detail: DatabaseDetail, node: unknown): unknown {
  // Tolerate a stringified filter (a common LLM mistake) — parse it once up front.
  if (typeof node === 'string') {
    try {
      node = JSON.parse(node);
    } catch {
      return node;
    }
  }
  if (!node || typeof node !== 'object') return node;
  for (const key of ['and', 'or'] as const) {
    const children = (node as Record<string, unknown>)[key];
    if (Array.isArray(children)) {
      return { [key]: children.map((child) => mapFilterValues(detail, child)) };
    }
  }
  const cond = node as { field?: string; op?: string; value?: unknown };
  if (typeof cond.field !== 'string') return node;
  const f = detail.fields.find((x) => x.apiName === cond.field);
  if (!f) return node;

  const isChoice = f.type === 'select' || f.type === 'multi_select';
  const isMembership = isChoice || f.type === 'user';
  if (!isMembership) return node;

  // Agents naturally write eq/neq on a select or person; the API models those as
  // has/has_none over an id ARRAY. Translate so the intuitive filter Just Works,
  // instead of a "op eq not valid for select" 422 (#204).
  let op = cond.op;
  let value = cond.value;
  if (op === 'eq' || op === 'neq') {
    op = op === 'eq' ? 'has' : 'has_none';
    value = Array.isArray(value) ? value : [value];
  }

  const toId = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    // The current-user sentinel: get_started advertises "@me".
    if (f.type === 'user' && (v === '@me' || v === 'me')) return 'me';
    if (isChoice && f.options?.length) {
      const opt = f.options.find((o) => o.id === v || o.label.toLowerCase() === v.toLowerCase());
      if (opt) return opt.id;
      throw new Error(
        `No option "${v}" on field "${f.apiName}". Available: ${f.options.map((o) => o.label).join(', ')}.`,
      );
    }
    return v;
  };
  value = Array.isArray(value) ? value.map(toId) : toId(value);
  return { ...cond, op, value };
}

/**
 * Each tool's minimum scope (MN-134). The advertised catalog = the token's scope
 * intersected with these floors, so a read-only token never even sees a mutating
 * tool. This mirrors the server-side @RequiresScope decorations exactly — the API
 * is the enforcement; this map is the UX that stops an agent calling a doomed tool.
 * run_button lives in `write` but is separately gateable via allow_run_button.
 */
const TOOL_SCOPE: Record<string, ToolScope> = {
  // read
  get_started: 'read',
  list_workspaces: 'read',
  list_databases: 'read',
  describe_database: 'read',
  search: 'read',
  query_records: 'read',
  get_record: 'read',
  get_links: 'read',
  list_attachments: 'read',
  list_spaces: 'read',
  list_icon_set: 'read',
  // write (record + content mutations)
  create_record: 'write',
  update_record: 'write',
  delete_record: 'write',
  link_records: 'write',
  unlink_records: 'write',
  add_comment: 'write',
  attach_file: 'write',
  delete_attachment: 'write',
  run_button: 'write',
  // admin (schema mutations)
  create_database: 'admin',
  update_database: 'admin',
  delete_database: 'admin',
  add_field: 'admin',
  update_field: 'admin',
  delete_field: 'admin',
  change_field_type: 'admin',
  reorder_fields: 'admin',
  create_view: 'admin',
  update_view: 'admin',
  delete_view: 'admin',
  reorder_views: 'admin',
  create_relation: 'admin',
  delete_relation: 'admin',
  create_space: 'admin',
};

/** Tools gated by run_button on top of write scope (MN-134). */
const RUN_BUTTON_TOOLS = new Set(['run_button']);

const SCOPE_RANK: Record<ToolScope, number> = { read: 0, write: 1, admin: 2 };

/** Human summary of what a scope excludes, for get_started. */
function scopeExclusions(effective: EffectiveScope): string {
  if (effective.scope === 'admin') {
    return effective.allowRunButton
      ? 'Full access — every tool is available.'
      : 'Full access, except run_button (this token cannot press buttons).';
  }
  const excluded: string[] = [];
  if (effective.scope === 'read') excluded.push('all writes (create/update/delete/link/comment/attach)', 'all schema tools');
  if (effective.scope === 'write') excluded.push('schema tools (create_database, add_field, create_view, create_relation, …)');
  if (SCOPE_RANK[effective.scope] >= SCOPE_RANK.write && !effective.allowRunButton) excluded.push('run_button');
  return `This token is ${effective.scope}-scoped. Not available: ${excluded.join('; ')}.`;
}

/**
 * Register the tool catalog (MN-076), trimmed to what the credential can do (MN-134).
 * `effective` comes from GET /me; a session/OAuth login (or a /me hiccup) is full admin.
 */
export function registerTools(server: McpServer, ctx: Ctx, effective: EffectiveScope = { scope: 'admin', allowRunButton: true }) {
  const { client } = ctx;

  /**
   * Gate registration on scope: a tool above the token's ceiling is never advertised,
   * and a run_button-gated tool is dropped when allow_run_button is false. Unknown
   * names default to admin (fail closed on the advertise side; the API still enforces).
   */
  const reg = (
    name: string,
    config: Record<string, unknown>,
    handler: (args: never) => unknown,
  ): void => {
    const need = TOOL_SCOPE[name] ?? 'admin';
    if (SCOPE_RANK[effective.scope] < SCOPE_RANK[need]) return;
    if (RUN_BUTTON_TOOLS.has(name) && !effective.allowRunButton) return;
    server.registerTool(name as string, config as never, handler as never);
  };
  reg(
    'get_started',
    {
      title: 'Get started',
      description:
        'Orientation for these tools + a map of a workspace (spaces → databases → fields) + the filter cheat-sheet. Call this first when working in a new workspace.',
      inputSchema: { workspace: z.string().optional().describe('Workspace name or id to map (optional).') },
    },
    handle<{ workspace?: string }>(async ({ workspace }) => {
      const intro = [
        'StoryOS MCP — read AND build a workspace of user-defined relational databases.',
        '',
        'READ:  list_workspaces → list_databases → describe_database (READ THE SCHEMA first) → query_records / search / get_record.',
        'WRITE: describe_database first, then create_record / update_record. Fill the FULL field template, not just a couple of fields.',
        'BUILD: list_spaces → create_space → create_database → add_field → create_view → create_relation. Then create_record to populate.',
        '',
        'Refs: address a database by its qualified "space/database" slug (from list_databases) — a bare name that exists in two spaces is rejected. Never invent ids; they come from search / list_* / a prior result. Names, slugs and select labels are resolved server-side.',
        'Values: select/multi_select take the human label (e.g. "High"); rich_text fields accept Markdown (headings, lists, links, code — parsed to blocks) and are returned to you as Markdown.',
        '',
        'Links: get_record / query_records / create_record / update_record all include a `url` — a clickable web-app link for that record, ready to hand to a user. Scheme: {web origin}/w/{workspace_id}/d/{database_id}/r/{title-slug}-{number} (falls back to the record uuid when it has no public number yet). workspace_id/database_id are the ids from list_workspaces/list_databases — never the human name/slug you passed in. Use get_links to resolve a database or view link, or a batch of record links, without a round-trip per record.',
        '',
        `SCOPE: ${scopeExclusions(effective)}`,
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

  reg(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: 'Every workspace the token can access (id, name, role).',
      inputSchema: {},
    },
    handle<Record<string, never>>(async () => text(await listWorkspaces(client))),
  );

  reg(
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

  reg(
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

  reg(
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

  reg(
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
        // Read the schema first so select labels in the filter can be resolved (#77).
        const detail = await getDetail(ws.id, db.id);
        const res = await unwrap<{ data: RecordRow[]; next_cursor: string | null; has_more: boolean }>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
            params: { path: { ws: ws.id, db: db.id } },
            body: { filter: mapFilterValues(detail, filter), sorts: sorts ?? [], limit: limit ?? 50, cursor } as never,
          }),
        );
        return text({
          records: res.data.map((r) => ({
            id: r.id,
            number: r.number,
            title: r.title,
            values: labelize(detail, r.values),
            url: recordUrl(ws.id, db.id, r),
          })),
          next_cursor: res.next_cursor,
          has_more: res.has_more,
        });
      },
    ),
  );

  reg(
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
      const detail = await getDetail(ws.id, db.id);
      return text({ ...row, values: labelize(detail, row.values), url: recordUrl(ws.id, db.id, row) });
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

  /** Full write mapping (#6 + labels + #60): select labels → ids, and a string on a
   * rich_text field is parsed as Markdown → blocks, so the model writes real structure
   * (headings/lists/links) instead of knowing the block format. An array passes through. */
  function mapWriteValues(detail: DatabaseDetail, values: Record<string, unknown>): Record<string, unknown> {
    const byApi = new Map(detail.fields.map((f) => [f.apiName, f]));
    const out = mapSelectLabels(detail, values);
    for (const [k, v] of Object.entries(out)) {
      if (byApi.get(k)?.type === 'rich_text' && typeof v === 'string') out[k] = markdownToBlocks(v);
    }
    return out;
  }

  /** Read mapping (#8 + #60): resolve select/multi_select option ids → labels, and
   * render rich_text blocks as Markdown so agents get readable prose, not raw block JSON. */
  function labelize(detail: DatabaseDetail, values: Record<string, unknown>): Record<string, unknown> {
    const byApi = new Map(detail.fields.map((f) => [f.apiName, f]));
    const out: Record<string, unknown> = { ...values };
    for (const [k, v] of Object.entries(values)) {
      const f = byApi.get(k);
      if (!f) continue;
      if (f.type === 'rich_text' && Array.isArray(v)) {
        out[k] = blocksToMarkdown(v);
        continue;
      }
      if (!f.options?.length) continue;
      const toLabel = (x: unknown) => f.options!.find((o) => o.id === x)?.label ?? x;
      if (f.type === 'select') out[k] = typeof v === 'string' ? toLabel(v) : v;
      else if (f.type === 'multi_select' && Array.isArray(v)) out[k] = v.map(toLabel);
    }
    return out;
  }

  /** Non-system fields with no value in `values` — surfaced by create_record so agents
   * (and their humans) notice a skeletal record instead of silently under-filling it (#14). */
  function unsetFields(detail: DatabaseDetail, values: Record<string, unknown>): string[] {
    const SYS = ['id', 'title', 'created_at', 'updated_at', 'created_by', 'formula', 'rollup', 'lookup'];
    return detail.fields
      .filter((f) => !SYS.includes(f.type))
      .filter((f) => values[f.apiName] === undefined || values[f.apiName] === null || values[f.apiName] === '')
      .map((f) => f.apiName);
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

  reg(
    'create_record',
    {
      title: 'Create record',
      description:
        'Create a record. values are keyed by api_name (call describe_database first); select/person values accept the human label, rich_text accepts Markdown, and relation fields accept an array of target record numbers or ids — linked in the same write, so no follow-up link_records. Returns the created record.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        values: z
          .record(z.string(), z.any())
          .describe(
            'Field values by api_name; "name" sets the title. A relation field takes an array of target record numbers or ids, e.g. { project: [12] } — created atomically with the record.',
          ),
      },
    },
    handle<{ workspace: string; database: string; values: Record<string, unknown> }>(async ({ workspace, database, values }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const row = await unwrap<RecordRow>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
          params: { path: { ws: ws.id, db: db.id } },
          body: { values: mapWriteValues(detail, values) } as never,
        }),
      );
      const record = { ...row, values: labelize(detail, row.values), url: recordUrl(ws.id, db.id, row) };
      const unset = unsetFields(detail, values);
      return text(
        unset.length
          ? { record, unset_fields: unset, note: `Left empty — if relevant to this record, fill them: ${unset.join(', ')}. Call describe_database to see each field.` }
          : record,
      );
    }),
  );

  reg(
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
            body: { values: mapWriteValues(detail, values) } as never,
          }),
        );
        return text({ ...row, values: labelize(detail, row.values), url: recordUrl(ws.id, db.id, row) });
      },
    ),
  );

  reg(
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

  reg(
    'link_records',
    {
      title: 'Link records',
      description:
        'Link a record through a relation field to target records (by uuid or public number). Default ADDS links. Use replace:true to set the link set to exactly `targets` — that is how you re-point or clear a one-to-many link (adding a second target without replace returns a 409). Get target ids from search / query_records first.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string(),
        relation_field: z.string().describe('The relation field on this database (api_name, name, or id).'),
        targets: z.array(z.string()).describe('Target record uuids or public numbers. With replace:true, an empty array clears all links.'),
        replace: z
          .boolean()
          .optional()
          .describe('Replace the whole link set with `targets` instead of adding to it — required to change a one-to-many link (#81).'),
      },
    },
    handle<{ workspace: string; database: string; record: string; relation_field: string; targets: string[]; replace?: boolean }>(
      async ({ workspace, database, record, relation_field, targets, replace }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const fieldId = resolveFieldId(detail, relation_field, ['relation'], 'relation');
        const rec = await resolveRecordId(ws.id, db.id, record);
        const relField = detail.fields.find((f) => f.id === fieldId);
        const targetDbId = relField?.relation?.target_database_id ?? db.id;
        const targetIds = await Promise.all(targets.map((t) => resolveRecordId(ws.id, targetDbId, t)));
        const path = { ws: ws.id, db: db.id, rec, field: fieldId };
        // PUT replaces the link set; POST adds. The API has always supported both —
        // only `add` was exposed, so "Use replace instead" was unreachable (#81).
        await unwrap(
          replace
            ? client.PUT('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}', {
                params: { path } as never,
                body: { record_ids: targetIds } as never,
              })
            : client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}', {
                params: { path } as never,
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

  reg(
    'unlink_records',
    {
      title: 'Unlink records',
      description:
        'Remove specific links from a record\'s relation field, leaving the relation and every other link intact. Use this (or link_records with replace) to fix a mis-link — never delete_relation, which drops the relation everywhere (#81).',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string(),
        relation_field: z.string().describe('The relation field on this database (api_name, name, or id).'),
        targets: z.array(z.string()).describe('Target record uuids or public numbers to unlink.'),
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
          client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}', {
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

  reg(
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

  // ============ Attachments (MN-37): files on a record ============

  const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', zip: 'application/zip', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const guessMime = (name: string): string | undefined => MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''];
  const nameFromUrl = (u: string): string => {
    try {
      const last = new URL(u).pathname.split('/').filter(Boolean).pop();
      return last ? decodeURIComponent(last) : 'file';
    } catch {
      return 'file';
    }
  };

  reg(
    'attach_file',
    {
      title: 'Attach file',
      description:
        'Attach a file to a record — either from a public `url` (fetched server-side) or from inline `content_base64` bytes. Images get a thumbnail automatically. record is a uuid or public number. Returns the created attachment.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        url: z.string().url().optional().describe('A publicly reachable URL to fetch and attach.'),
        content_base64: z.string().optional().describe('Base64-encoded file bytes (use instead of url).'),
        filename: z.string().optional().describe('File name — required with content_base64; inferred from the URL otherwise.'),
        mime: z.string().optional().describe('MIME type, e.g. "image/png". Inferred from the extension / URL response when omitted.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; url?: string; content_base64?: string; filename?: string; mime?: string }>(
      async ({ workspace, database, record, url, content_base64, filename, mime }) => {
        if (!url && !content_base64) throw new Error('Provide either `url` or `content_base64`.');
        if (url && content_base64) throw new Error('Provide only one of `url` or `content_base64`, not both.');
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);

        let data: Uint8Array;
        let name = filename;
        let type = mime;
        if (url) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Could not fetch ${url} (HTTP ${res.status}).`);
          data = new Uint8Array(await res.arrayBuffer());
          name = name ?? nameFromUrl(url);
          type = type ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? guessMime(name);
        } else {
          if (!filename) throw new Error('`filename` is required when attaching content_base64.');
          data = Uint8Array.from(Buffer.from(content_base64!, 'base64'));
          name = filename;
          type = type ?? guessMime(filename);
        }

        const attachment = await uploadAttachment(ctx, { ws: ws.id, db: db.id, rec }, { filename: name!, mime: type, data });
        return text(attachment);
      },
    ),
  );

  reg(
    'list_attachments',
    {
      title: 'List attachments',
      description: 'List the files attached to a record (id, filename, mime, size). record is a uuid or public number.',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string() },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/attachments', {
          params: { path: { ws: ws.id, db: db.id, rec } },
        }),
      );
      return text(res);
    }),
  );

  reg(
    'delete_attachment',
    {
      title: 'Delete attachment',
      description: 'Remove a file from a record by attachment id (from list_attachments). record is a uuid or public number.',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string(), attachment_id: z.string() },
    },
    handle<{ workspace: string; database: string; record: string; attachment_id: string }>(
      async ({ workspace, database, record, attachment_id }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const res = await unwrap<unknown>(
          client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/attachments/{att}', {
            params: { path: { ws: ws.id, db: db.id, rec, att: attachment_id } } as never,
          }),
        );
        return text(res ?? { deleted: attachment_id });
      },
    ),
  );

  reg(
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
    const spaces = await unwrap<Array<{ id: string; name: string; slug?: string }>>(
      client.GET('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws: wsId } as never } }),
    );
    const lower = ref.trim().toLowerCase();
    const s = spaces.find((x) => x.id === ref || x.name.toLowerCase() === lower || x.slug?.toLowerCase() === lower);
    if (!s) throw new Error(`No space matches "${ref}". Available: ${spaces.map((x) => x.slug ?? x.name).join(', ') || '(none)'}.`);
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

  reg(
    'list_icon_set',
    {
      title: 'List icon set',
      description:
        'List the curated StoryOS icon names, grouped by category, as the "set:<name>" refs accepted by the icon param on create_database, update_database, create_space and update_space (#251). Call this before setting an icon so you pick a real name.',
      inputSchema: {},
    },
    handle<Record<string, never>>(async () => text(buildIconCatalog())),
  );

  reg(
    'create_database',
    {
      title: 'Create database',
      description:
        'Create a new database (table) in a space. Returns it with its auto-created system fields (id, name). Then shape it with add_field and create_view.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().describe('Space name or id the database belongs to.'),
        name: z.string().describe('Database name, e.g. "Clients".'),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
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
    'url', 'email', 'color', 'user', 'lookup', 'rollup', 'button', 'formula',
  ] as const;
  const optionShape = z.union([z.string(), z.object({ label: z.string(), color: z.string().optional() })]);
  const normOptions = (o?: Array<string | { label: string; color?: string }>) =>
    o?.map((x) => (typeof x === 'string' ? { label: x } : x));

  reg(
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

  reg(
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

  reg(
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
  type ViewOpts = { group_by?: string; card_fields?: string[]; date_field?: string; start_date_field?: string; end_date_field?: string; filters?: unknown; sorts?: Array<{ field: string; direction?: string }> };
  function buildViewConfig(detail: DatabaseDetail, type: string, o: ViewOpts): Record<string, unknown> {
    const config: Record<string, unknown> = { sorts: o.sorts ?? [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };
    // Saved views take the same AST, so resolve select labels here too (#77).
    if (o.filters) config.filters = mapFilterValues(detail, o.filters);
    if (o.card_fields) config.card_field_ids = o.card_fields.map((f) => anyField(detail, f));
    if (type === 'board' && o.group_by) config.group_by_field_id = anyField(detail, o.group_by);
    if (type === 'calendar' && o.date_field) config.date_field_id = anyField(detail, o.date_field);
    if (type === 'timeline') {
      if (o.start_date_field) config.start_date_field_id = anyField(detail, o.start_date_field);
      if (o.end_date_field) config.end_date_field_id = anyField(detail, o.end_date_field);
    }
    return config;
  }

  reg(
    'create_view',
    {
      title: 'Create view',
      description:
        'Create a saved view. board needs group_by (a select, a single user, or a one-to-many relation field); calendar needs date_field; timeline needs start_date_field/end_date_field; board/gallery/list show card_fields (chips on calendar).',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        name: z.string(),
        type: z.enum(VIEW_TYPES),
        group_by: z.string().optional().describe('board: field to group columns by — a select, a single user, or the single side of a one-to-many relation (one column per related record).'),
        card_fields: z.array(z.string()).optional().describe('Fields shown on cards / chips.'),
        date_field: z.string().optional().describe('calendar: the date field.'),
        start_date_field: z.string().optional().describe('timeline: start date field.'),
        end_date_field: z.string().optional().describe('timeline: end date field.'),
        filters: z.any().optional().describe('Filter AST by field api_name — same shape as query_records (see get_started).'),
        sorts: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']).optional() })).optional().describe('Sort keys by field api_name.'),
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

  reg(
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
        filters: z.any().optional(),
        sorts: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']).optional() })).optional(),
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

  reg(
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

  reg(
    'get_links',
    {
      title: 'Get links',
      description:
        'Resolve web-app URLs — for records, a database, and/or its saved views — without a round-trip per record. get_record / query_records / create_record / update_record already include a `url` on each record; reach for this tool for a database link, a view link, or a batch of record links in one call.',
      inputSchema: {
        workspace: z.string(),
        database: z.string().optional().describe('Database name, api slug, or id. Required to resolve `records` or `views`; on its own, returns just the database link.'),
        records: z.array(z.string()).optional().describe('Record uuids or public numbers to link.'),
        views: z.array(z.string()).optional().describe('View names or ids to link.'),
      },
    },
    handle<{ workspace: string; database?: string; records?: string[]; views?: string[] }>(
      async ({ workspace, database, records, views }) => {
        const ws = await resolveWorkspace(client, workspace);
        if (!database) {
          if (records?.length || views?.length) throw new Error('`database` is required to resolve `records` or `views`.');
          return text({ workspace: ws.id });
        }
        const db = await resolveDatabase(client, ws.id, database);
        const out: { database: string; records?: Record<string, string>; views?: Record<string, string> } = {
          database: databaseUrl(ws.id, db.id),
        };
        if (records?.length) {
          out.records = {};
          for (const ref of records) {
            const rec = await resolveRecordId(ws.id, db.id, ref);
            const row = await unwrap<RecordRow>(
              client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', { params: { path: { ws: ws.id, db: db.id, rec } } }),
            );
            out.records[ref] = recordUrl(ws.id, db.id, row);
          }
        }
        if (views?.length) {
          const detail = await getDetail(ws.id, db.id);
          out.views = {};
          for (const ref of views) {
            const v = resolveView(detail, ref);
            out.views[ref] = viewUrl(ws.id, db.id, v.id);
          }
        }
        return text(out);
      },
    ),
  );

  // ============ Relations (MN-146 fast-follow): link databases ============

  reg(
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

  reg(
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

  // ============ Spaces + database/field management (backlog #1,2,4,5,9,10,11) ============

  reg(
    'list_spaces',
    {
      title: 'List spaces',
      description: 'List the spaces in a workspace (id, name, slug). Databases live in spaces; use a space name/slug with create_database.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaces = await unwrap<Array<{ id: string; name: string; slug?: string }>>(
        client.GET('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws: ws.id } } as never }),
      );
      return text(spaces.map((s) => ({ id: s.id, name: s.name, slug: s.slug })));
    }),
  );

  reg(
    'create_space',
    {
      title: 'Create space',
      description: 'Create a space (a named group of databases). Returns it with its slug — pass that to create_database to build inside it.',
      inputSchema: {
        workspace: z.string(),
        name: z.string().describe('Space name, e.g. "Client Work".'),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
        color: z.string().optional(),
      },
    },
    handle<{ workspace: string; name: string; icon?: string; color?: string }>(async ({ workspace, name, icon, color }) => {
      const ws = await resolveWorkspace(client, workspace);
      const space = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/spaces', {
          params: { path: { ws: ws.id } } as never,
          body: { name, icon, color } as never,
        }),
      );
      return text(space);
    }),
  );

  reg(
    'delete_database',
    {
      title: 'Delete database',
      description: 'Permanently delete a database and all its records (irreversible). Guardrail: `confirm` must equal the database name exactly. Set sever_relations to also drop relations pointing at it.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        confirm: z.string().describe('Must equal the database name exactly.'),
        sever_relations: z.boolean().optional(),
      },
    },
    handle<{ workspace: string; database: string; confirm: string; sever_relations?: boolean }>(
      async ({ workspace, database, confirm, sever_relations }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const res = await unwrap<unknown>(
          client.DELETE('/api/v1/workspaces/{ws}/databases/{db}', {
            params: { path: { ws: ws.id, db: db.id } } as never,
            body: { confirm, sever_relations } as never,
          }),
        );
        return text(res ?? { deleted: true });
      },
    ),
  );

  reg(
    'update_database',
    {
      title: 'Update database',
      description: 'Rename a database, set its icon, or move it to another space. The api_slug is stable (rename does not change the ref). Only the fields you pass change.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        rename_to: z.string().optional(),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
        move_to_space: z.string().optional().describe('Space name or slug to move the database into.'),
      },
    },
    handle<{ workspace: string; database: string; rename_to?: string; icon?: string; move_to_space?: string }>(
      async ({ workspace, database, rename_to, icon, move_to_space }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const body: Record<string, unknown> = {};
        if (rename_to) body.name = rename_to;
        if (icon !== undefined) body.icon = icon;
        if (move_to_space) body.space_id = await resolveSpaceId(ws.id, move_to_space);
        const res = await unwrap<unknown>(
          client.PATCH('/api/v1/workspaces/{ws}/databases/{db}', {
            params: { path: { ws: ws.id, db: db.id } } as never,
            body: body as never,
          }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'change_field_type',
    {
      title: 'Change field type',
      description: 'Convert a field to a different type (e.g. text → select). Set dry_run to preview the conversion result without applying. Unsupported conversions return a clear error.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        field: z.string(),
        new_type: z.enum(FIELD_TYPES),
        dry_run: z.boolean().optional(),
      },
    },
    handle<{ workspace: string; database: string; field: string; new_type: string; dry_run?: boolean }>(
      async ({ workspace, database, field, new_type, dry_run }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const fieldId = anyField(detail, field);
        const res = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/change-type', {
            params: { path: { ws: ws.id, db: db.id, field: fieldId } } as never,
            body: { type: new_type, dry_run: dry_run ?? false } as never,
          }),
        );
        return text(res);
      },
    ),
  );

  const reorder = async (
    wsId: string,
    dbId: string,
    order: string[],
    resolveOne: (detail: DatabaseDetail, ref: string) => string,
    patchPath: '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}' | '/api/v1/workspaces/{ws}/databases/{db}/views/{view}',
    key: 'field' | 'view',
  ) => {
    const detail = await getDetail(wsId, dbId);
    const ids = order.map((ref) => resolveOne(detail, ref));
    for (let i = 0; i < ids.length; i++) {
      await unwrap<unknown>(
        client.PATCH(patchPath, { params: { path: { ws: wsId, db: dbId, [key]: ids[i] } } as never, body: { position: i } as never }),
      );
    }
    return getDetail(wsId, dbId);
  };

  reg(
    'reorder_fields',
    {
      title: 'Reorder fields',
      description: 'Set the order of fields in a database. Pass the field names (or api_names) in the desired order; any omitted stay after the ordered ones.',
      inputSchema: { workspace: z.string(), database: z.string(), order: z.array(z.string()).describe('Field names in desired order.') },
    },
    handle<{ workspace: string; database: string; order: string[] }>(async ({ workspace, database, order }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await reorder(ws.id, db.id, order, anyField, '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', 'field');
      return text(detail.fields.map((f) => f.apiName));
    }),
  );

  reg(
    'reorder_views',
    {
      title: 'Reorder views',
      description: 'Set the order of views in a database. Pass the view names in the desired order.',
      inputSchema: { workspace: z.string(), database: z.string(), order: z.array(z.string()).describe('View names in desired order.') },
    },
    handle<{ workspace: string; database: string; order: string[] }>(async ({ workspace, database, order }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await reorder(ws.id, db.id, order, (d, ref) => resolveView(d, ref).id, '/api/v1/workspaces/{ws}/databases/{db}/views/{view}', 'view');
      return text((detail.views ?? []).map((v) => v.name));
    }),
  );
}
