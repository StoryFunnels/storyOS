import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx, EffectiveScope, ToolScope } from './client.js';
import { unwrap, uploadAttachment } from './client.js';
import { SCHEMA_VERSION_NOTICE } from './schema-version.js';
// Subpath, not the barrel: markdown/icons are zod-free, and pulling the whole
// schemas index into this ESM bundle inlines a CJS require('zod') that throws
// at boot.
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas/markdown';
import { BRAND_ICON_META, BRAND_ICON_PREFIX, ICON_CATEGORIES, ICON_SET_META, ICON_SET_PREFIX } from '@storyos/schemas/icons';
// Subpath, not the barrel: the system-field registry is zod-free (see note above),
// so it can be imported as a value here without inlining a CJS require('zod').
import { SYSTEM_FIELDS, SYSTEM_FIELD_BY_API_NAME } from '@storyos/schemas/system-fields';
// Type-only — erased at compile time, so unlike a value import this does NOT pull
// the zod-bearing barrel into the bundle (see note above).
import type { FilterOp } from '@storyos/schemas';
// Subpath, not the barrel (see note above) — colors.ts is pure data with no zod
// import, but reaching it through the index would inline the whole zod-bearing
// barrel and the mcp image would fail to boot. It did, on this branch, in CI.
import { PALETTE as SHARED_PALETTE } from '@storyos/schemas/colors';
import { listDatabases, listSkills, listWorkspaces, resolveDatabase, resolveFolder, resolveSkill, resolveWorkspace } from './resolve.js';
import type { SkillRef } from './resolve.js';
import { databaseUrl, recordUrl, viewUrl, webBaseUrl } from './links.js';
import {
  annotateActions,
  buildAutomationTrigger,
  readableAutomation,
  resolveActionFieldRefs,
  resolveValueMap,
  type AutomationRow,
  type LastRun,
  type TriggerInput,
} from './automations.js';

/**
 * #400 — the purpose line, shared by every level that carries one.
 *
 * Worded to tell an agent WHY to set it, not just that it may: a description is
 * the cheapest context the product can give the next reader (human or model),
 * and an agent that has just been told what to build already has the sentence in
 * hand. Left unset, the sentence is thrown away at the only moment it existed.
 */
const DESCRIPTION_PARAM =
  'One line (max 200 chars) saying what this is FOR — read by list_* and describe_database, so it becomes context for whoever works here next. Set it when you create something: you already know the purpose at that moment.';

/**
 * #398 — the palette. Named explicitly rather than left free-text, so an agent
 * picks a real colour instead of discovering the server rejects "navy".
 */
/*
 * #399 — DERIVED, after this file was the fourth hardcoded copy.
 *
 * The #399 ticket predicted this exactly: "#398 exposes database colour over
 * MCP. Whoever builds that hits this immediately, and would otherwise hardcode a
 * third copy of the palette into a tool description." That is what happened —
 * PR #404 shipped a ten-value literal here, which was already the SHORT list, so
 * an agent could not set the five colours a human could.
 */
const PALETTE = SHARED_PALETTE;
const COLOR_PARAM =
  `Palette colour: ${PALETTE.join(', ')}. Omit on create and one is auto-assigned AT RANDOM — which is how a set of databases ends up with two purples, so pass distinct colours deliberately when building several.`;

/** Icon param description shared by create_database/update_database/create_space
 * (#251: emoji retired as the picker option in-app; the MCP surface keeps
 * accepting it for back-compat but no longer advertises it as the default). */
export const ICON_PARAM_DESCRIPTION =
  'A curated icon ref, e.g. "set:rocket" or a brand/logo ref like "brand:github" (#298) — call list_icon_set for the full catalog. ' +
  'A raw emoji (e.g. "📁") still works for backward compatibility with older data, but is not the preferred form.';

/** Curated icon names grouped by category label, plus the brand/logo set
 * (#298), for the list_icon_set tool (#251). Both halves are read straight
 * off @storyos/schemas/icons — the same module apps/web's icon-picker.tsx
 * pulls from — so a new icon added there needs no changes here to show up.
 * Exported standalone (like mapFilterValues below) so it's testable without
 * registering a full McpServer. */
export function buildIconCatalog(): {
  prefix: string;
  categories: Record<string, string[]>;
  brands: { prefix: string; icons: { slug: string; name: string; keywords: string }[] };
} {
  const byCategory: Record<string, string[]> = {};
  for (const cat of ICON_CATEGORIES) byCategory[cat.label] = [];
  for (const icon of ICON_SET_META) {
    for (const catId of icon.categories) {
      const label = ICON_CATEGORIES.find((c) => c.id === catId)?.label ?? catId;
      (byCategory[label] ??= []).push(icon.name);
    }
  }
  return {
    prefix: ICON_SET_PREFIX,
    categories: byCategory,
    brands: { prefix: BRAND_ICON_PREFIX, icons: BRAND_ICON_META },
  };
}

/** MCP text result. */
function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

/** Wrap a handler so any error (incl. the API's typed 422) is returned to the model
 * as an isError result — validation-as-teacher, so it self-corrects in one turn. */
/**
 * #343 — reject an argument name the tool does not have, instead of dropping it.
 *
 * `inputSchema` is a plain zod SHAPE, and the SDK turns it into a `z.object()`,
 * which STRIPS unknown keys by default. So a misspelled argument was silently
 * discarded and the call still reported success. That is how this very ticket got
 * filed with an empty title: `create_record` was called with a top-level `title`
 * (the correct spelling is `values.name`), the key was dropped on the floor, and a
 * nameless record came back as a 200.
 *
 * A wrong guess about an argument name is the single most likely mistake a model
 * makes against an unfamiliar tool, and silence is the one response that guarantees
 * it never learns. Naming the valid arguments turns a corrupt write into a retry.
 *
 * Wrapped here, in the one place every tool is registered, rather than per tool —
 * the whole point is that no tool gets to be the lenient one.
 */
function rejectUnknownArgs(
  name: string,
  config: Record<string, unknown>,
  handler: (args: never) => unknown,
): (args: never) => unknown {
  const shape = config['inputSchema'];
  if (!shape || typeof shape !== 'object') return handler;
  const allowed = new Set(Object.keys(shape as Record<string, unknown>));
  return (args: never) => {
    const given = args as unknown;
    if (given && typeof given === 'object' && !Array.isArray(given)) {
      // `_`-prefixed keys are MCP protocol metadata (e.g. `_meta`), never tool args.
      const unknown = Object.keys(given as Record<string, unknown>).filter((k) => !k.startsWith('_') && !allowed.has(k));
      if (unknown.length) {
        const valid = [...allowed].join(', ') || '(none)';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Error: ${name} has no argument named ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
                `Valid arguments: ${valid}. ` +
                `Nothing was written — fix the name and call again.`,
            },
          ],
          isError: true,
        };
      }
    }
    return handler(args);
  };
}

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
  options?: Array<{ id: string; label: string; color?: string; icon?: string | null }>;
  relation?: { id?: string; target_database_id: string; target_database_name: string | null; cardinality: string; side: string };
}
interface DatabaseDetail {
  id: string;
  name: string;
  /** #400 — the database's own purpose line (NOT the record description of #310). */
  description?: string | null;
  spaceSlug?: string | null;
  qualifiedSlug?: string;
  my_access?: string;
  fields: FieldDef[];
  // #191: the detail endpoint returns each view's cleaned `config` too — needed so
  // update_view can merge a partial change onto the existing config (a true patch).
  views?: Array<{ id: string; name: string; type: string; config?: Record<string, unknown> }>;
}
interface RecordRow {
  id: string;
  number: number | null;
  title: string;
  values: Record<string, unknown>;
}

/**
 * The op×field-type matrix, kept in one place so the cheat sheet below can
 * never silently drift from what the API actually accepts (#204: the old
 * hand-written prose advertised a "starts_with" op that was never real — any
 * agent that followed the doc got a 422 on every text filter it tried).
 * Source of truth: apps/api/src/records/query-compiler.ts's per-type switch;
 * mirrors the same matrix as apps/web's OPS_BY_TYPE (view-toolbar.tsx), plus
 * the extra eq/neq the MCP additionally accepts and translates for select/
 * multi_select/user via mapFilterValues below.
 */
export const OPS_BY_FIELD_TYPE = {
  'text/url/email': ['eq', 'neq', 'contains', 'is_empty', 'not_empty'],
  'number/id': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'],
  date: ['eq', 'neq', 'before', 'after', 'within', 'is_empty', 'not_empty'],
  select: ['eq', 'neq', 'has', 'has_none', 'is_empty', 'not_empty'],
  multi_select: ['has', 'has_none', 'is_empty', 'not_empty'],
  user: ['eq', 'neq', 'has', 'has_none', 'is_empty', 'not_empty'],
  // #391 — presence only, matching query-compiler.ts, which refuses everything
  // else outright rather than accepting an op it cannot answer.
  attachment: ['is_empty', 'not_empty'],
  relation: ['has', 'has_none', 'is_empty', 'not_empty'],
  checkbox: ['eq', 'neq'],
} satisfies Record<string, FilterOp[]>;

function opsRow(label: keyof typeof OPS_BY_FIELD_TYPE, hint?: string): string {
  const ops = OPS_BY_FIELD_TYPE[label];
  const padded = label.padEnd(14);
  return hint ? `  ${padded} : ${ops.join(', ')}  (${hint})` : `  ${padded} : ${ops.join(', ')}`;
}

export const FILTER_GUIDE = [
  'Filtering uses a structured AST (never free text):',
  '  filter = { "and": [ <condition>, ... ] }   // or "or"; conditions nest',
  '  condition = { "field": "<api_name>", "op": "<operator>", "value": <value> }',
  'A bare single condition (no and/or wrapper) also works — both are accepted.',
  'Operators by field type (call describe_database for exact api_names; the server',
  'validates and returns a typed error naming any mismatch):',
  opsRow('text/url/email', 'value = a string'),
  opsRow('number/id', 'value = a number'),
  opsRow('date', 'value = ISO string, or a relative token for "within"'),
  opsRow('select', 'value = option label or id; eq/neq auto-map to has/has_none'),
  opsRow('multi_select', 'value = [labels or ids]'),
  opsRow('user', 'value = "@me" or user id(s); eq/neq auto-map to has/has_none'),
  // #391 — presence only. Nobody filters on a file uuid; "posts with no cover"
  // is the question, and is_empty/not_empty is the whole of the answer.
  opsRow('attachment', 'is_empty / not_empty only — "records with no cover image"'),
  opsRow('relation', 'value = [record ids]'),
  opsRow('checkbox', 'value = true | false'),
  'Relative date tokens for "within": today, yesterday, tomorrow, last_7_days,',
  'next_7_days, this_month, next_30_days.',
  'System fields — every database has these built-in columns, filterable AND sortable',
  'by these api_names (read-only, never in create/update values):',
  ...SYSTEM_FIELDS.map(
    (f) => `  ${f.api_name.padEnd(14)} : ${f.filter_ops.join(', ')}${f.sortable ? '  (sortable)' : ''}`,
  ),
  '  number/id are the record\'s sequential public number; created_by/updated_by take a',
  '  user id or "@me"; created_at/updated_at take an ISO string or a "within" token.',
  'Example (grouped): { "and": [{ "field": "priority", "op": "eq", "value": "Urgent" }] }',
  'Example (bare):     { "field": "priority", "op": "eq", "value": "Urgent" }',
  'Example (system):   { "field": "number", "op": "gte", "value": 320 }  + sorts:[{ "field": "created_at", "direction": "desc" }]',
].join('\n');

function describeFields(db: DatabaseDetail) {
  // Non-system stored fields (title + user-defined) as-is. System columns come
  // from the ONE canonical registry below rather than the per-database stored
  // rows, so describe enumerates the FULL, consistent set — the same api_names
  // and ops the API's filter/sort resolver accepts (#354: previously only `id`
  // showed; created_at/updated_at/created_by were hidden and updated_by/number
  // were entirely absent).
  const stored = db.fields
    .filter((f) => !f.isSystem && !SYSTEM_FIELD_BY_API_NAME.has(f.apiName))
    .map((f) => {
      const out: Record<string, unknown> = { api_name: f.apiName, name: f.displayName, type: f.type };
      // #216: `icon` is returned so what an agent reads is what it can write
      // back. Omitted when absent, keeping the common no-icon case terse.
      if (f.options?.length)
        out.options = f.options.map((o) => ({
          label: o.label,
          color: o.color,
          ...(o.icon ? { icon: o.icon } : {}),
        }));
      if (f.relation) out.links_to = f.relation.target_database_name ?? f.relation.target_database_id;
      return out;
    });
  const system = SYSTEM_FIELDS.map((f) => ({
    api_name: f.api_name,
    name: f.display_name,
    type: f.type,
    read_only: true as const,
    ops: f.filter_ops,
    sortable: f.sortable,
  }));
  return [...stored, ...system];
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
/**
 * #334 — a structured (object/array) tool parameter that may arrive as a JSON
 * STRING, because plenty of MCP clients serialise object arguments.
 *
 * Applied in the HANDLERS rather than as a zod `preprocess` on the input shape.
 * A schema-layer fix only runs on the path where the SDK validates input, which
 * makes it both untestable through the handler and silently absent anywhere the
 * handler is reached directly.
 *
 * These params are declared `z.any()`, which accepts a string happily and hands
 * it straight to code that expects an object. `create_automation` was therefore
 * unusable from any such client: every call died on `trigger must be an object
 * with a "type"` — blaming the trigger, which was correct, when the transport
 * was the problem. `mapFilterValues` already tolerated this for `filter`, so
 * query_records worked from the very same client and the failure read like
 * caller error. This makes the tolerance uniform instead of incidental.
 *
 * A string that isn't valid JSON is a real caller mistake, and the error says
 * exactly that rather than mislabelling it as a shape problem.
 */
/**
 * Accept a JSON STRING wherever a tool declares a structured (or boolean, or
 * numeric) argument.
 *
 * `parseStructuredParam` above already existed for this, and it was dead code
 * for the params that needed it most: the zod `inputSchema` rejects a
 * stringified value BEFORE the handler runs, so `values`, `targets`, `replace`
 * and friends failed validation and the handler's tolerance was never reached.
 *
 * This is a real client problem, not a hypothetical one. Some MCP clients
 * serialise every argument as a string — a session hit exactly that and could
 * READ fine (all-string params) while every WRITE failed, which reads like a
 * broken server rather than a serialisation quirk.
 *
 * Type-agnostic on purpose: rather than introspecting zod internals (which shift
 * between major versions), it only intervenes when the value does NOT already
 * satisfy the schema. A `z.string()` param is untouched because a string always
 * validates; a `z.array()` given `'["a"]'` gets one JSON.parse attempt. A string
 * that is not valid JSON falls through to the ORIGINAL validation error, so a
 * genuine caller mistake still reads as a shape problem rather than a parse one.
 */
export function coerceStringified<T extends z.ZodTypeAny>(schema: T): z.ZodTypeAny {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    if (schema.safeParse(value).success) return value; // already valid — leave it alone
    const trimmed = value.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed !== '' && Number.isFinite(Number(trimmed)) && schema.safeParse(Number(trimmed)).success) {
      return Number(trimmed);
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return value; // let the schema produce its own error
    }
  }, schema);
}

/** Apply the coercion to every declared param of one tool's inputSchema. */
export function coerceInputSchema(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== 'object') return inputSchema;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(inputSchema as Record<string, unknown>)) {
    out[key] =
      schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function'
        ? coerceStringified(schema as z.ZodTypeAny)
        : schema;
  }
  return out;
}

export function parseStructuredParam(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      `${label} must be an object or a JSON string; got a string that isn't valid JSON: ${value.slice(0, 80)}`,
    );
  }
}

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

  // #354: created_by/updated_by are scalar person system columns — eq/neq stay as-is
  // (the API resolves them directly), but the "@me" sentinel still needs translating
  // to the "me" the server understands. updated_by has no stored field row, so this
  // is driven off the registry by api_name, not detail.fields.
  const sysSpec = SYSTEM_FIELD_BY_API_NAME.get(cond.field);
  if (sysSpec && (sysSpec.type === 'created_by' || sysSpec.type === 'updated_by')) {
    const meToken = (v: unknown) => (v === '@me' || v === 'me' ? 'me' : v);
    const value = Array.isArray(cond.value) ? cond.value.map(meToken) : meToken(cond.value);
    return { ...cond, value };
  }

  const f = detail.fields.find((x) => x.apiName === cond.field);
  if (!f) return node;

  // #172: a workflow field is single-select-shaped (one coloured option id), so it
  // resolves labels ↔ ids exactly like `select`. Omitting it here made "Me/label"
  // filters and writes on the canonical status field 422 with "unknown option id".
  const isChoice = f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow';
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
  count_records: 'read',
  get_record: 'read',
  get_links: 'read',
  list_attachments: 'read',
  /*
   * #406 areas 1–3. Each mirrors its controller's floor: the trash listing and
   * the batch delete/restore pair are `editor` on the database, duplicate is
   * `creator`, move is `contributor` — all of which sit inside the token scope
   * `write`, so the split here is read-vs-write exactly as the API sees it.
   * Reading history, comments and watchers is `viewer`, i.e. read.
   */
  list_trash: 'read',
  list_records: 'read',
  list_comments: 'read',
  get_history: 'read',
  list_backlinks: 'read',
  list_watchers: 'read',
  list_linked_records: 'read',
  list_spaces: 'read',
  /*
   * #444 — documents and folders. The two halves sit at DIFFERENT floors and
   * that is the API's doing, not a choice made here: SpaceDocumentsController
   * is unmarked, so it defaults by method (GET → read, PATCH/POST/DELETE →
   * write), while FoldersController carries a class-level
   * `@RequiresScope('admin')`. So a write-scoped token can write a page and
   * cannot create the folder to file it in. Mirrored rather than smoothed over:
   * the map exists to stop an agent calling a doomed tool, and pretending the
   * floors match would cause exactly that.
   */
  list_documents: 'read',
  get_document: 'read',
  create_document: 'write',
  update_document: 'write',
  delete_document: 'write',
  list_folders: 'admin',
  create_folder: 'admin',
  update_folder: 'admin',
  delete_folder: 'admin',
  // #394 — the pack gallery is public/read-only; installing one is admin.
  list_packs: 'read',
  /*
   * #446 — the rest of the pack surface. Reads are `read`; the two writes are
   * `admin` because that is where install_pack already sits and they change the
   * same thing it does (schema). export_pack creates nothing, but it reads the
   * whole shape of a workspace out in one call, which is an admin-shaped read.
   */
  list_installed_packs: 'read',
  browse_pack_marketplace: 'read',
  list_pack_submissions: 'read',
  list_templates: 'read',
  export_pack: 'admin',
  uninstall_pack: 'admin',
  apply_template: 'admin',
  remove_sample_data: 'admin',
  /*
   * #445 — relation configuration. get_relation is a schema read, and the rest
   * mirror the RelationsController's `creator` floor on BOTH databases. Same
   * ceiling as create_relation/delete_relation: an auto-link rule decides what
   * links exist from now on, which is schema, not data.
   */
  /* #448 — the graph. Same admin ceiling as get_relation (the controller is
   * class-level admin-scoped); the per-viewer database filtering inside is a
   * different axis and applies regardless of token scope. */
  list_relations: 'read',
  get_relation: 'read',
  set_auto_link: 'admin',
  run_auto_link: 'admin',
  find_select_drift: 'read',
  fix_select_drift: 'admin',
  list_icon_set: 'read',
  get_record_description: 'read',
  list_skills: 'read',
  /*
   * #442 — skill authoring. The SkillsController floors create/update/delete at
   * `@MinRole('member')` on the workspace, which is a ROLE and not a token
   * scope; the token-scope equivalent of "writes prose the product will act on"
   * is `write`, the same floor add_comment and create_record sit at. NOT admin:
   * a skill is not schema, and an agent-authored skill is personal to its owner
   * and cannot be published (SkillsService.assertMayPublish), so it changes
   * nothing anyone else sees.
   */
  get_skill: 'read',
  list_skill_templates: 'read',
  export_skill: 'read',
  create_skill: 'write',
  update_skill: 'write',
  delete_skill: 'write',
  // MN-255: read-only by design — approve/reject are Inbox-only in v1, so
  // an agent can queue work for a human to decide but never decide for one.
  list_approvals: 'read',
  /*
   * #439 — the inbox. Reads are `read`. Marking read/archived is a `write`
   * because it changes what a PERSON will see next time they look, even though
   * it writes no business data — the notification is theirs, not the agent's.
   */
  /*
   * #437 — view management. Reads are `read`; view CRUD sits at `admin` with
   * create_view/update_view/delete_view, because a view IS schema-adjacent —
   * set_default_view in particular changes what every member lands on.
   *
   * The personal filter is the exception and deliberately so: it writes only
   * for the calling identity and is invisible to everyone else, so it is a
   * `write`, not an admin act. Same reasoning as watch_record (#406 area 3).
   */
  get_view: 'read',
  list_space_views: 'read',
  get_personal_filter: 'read',
  set_personal_filter: 'write',
  duplicate_view: 'admin',
  set_default_view: 'admin',
  create_space_view: 'admin',
  update_space_view: 'admin',
  delete_space_view: 'admin',
  /*
   * #440 — the personal surfaces. Both are per-identity: get_my_work reads the
   * caller's own work and set_favorite stars for the caller only, so neither
   * can affect what a teammate sees. Starring is a `write` because it changes
   * the caller's sidebar.
   */
  /*
   * #441 — membership READS only; the write half is EXCLUDED in coverage.ts.
   *
   * list_members is `read` and returns no email (see the tool). Grants and
   * pending invites are `admin`: "who can reach what" is a security posture,
   * and a pending invite names someone who is not yet a member and has
   * accepted nothing — both belong at the same ceiling as the routes that
   * change them, even though these only look.
   */
  list_members: 'read',
  list_grants: 'admin',
  list_invites: 'admin',
  get_my_work: 'read',
  set_favorite: 'write',
  list_notifications: 'read',
  get_unread_count: 'read',
  mark_notifications: 'write',
  // MN-264: read-only — rerun is an app-only action (permission-checked,
  // human-confirmed), not exposed to an agent via MCP.
  get_runs: 'read',
  /*
   * #447 — the agent engine. AgentsController is admin-gated (it provisions a
   * space and writes bindings validated against live schema), so the writes
   * mirror that. The reads are `read`: seeing what an agent did, what a run
   * cost, and what a parked run is waiting for is ordinary context.
   *
   * get_staged_action is READ scope and read-only on purpose. Approving is
   * human-only (ADR-0010) and has no tool at any scope — a `write`-scoped
   * staged-action tool would be one refactor away from someone adding the
   * approve call next to it.
   */
  get_agents: 'read',
  get_run: 'read',
  get_run_quota: 'read',
  get_staged_action: 'read',
  setup_agents: 'admin',
  run_agent: 'admin',
  delegate_to_agent: 'admin',
  create_agent_trigger: 'admin',
  rerun_action: 'admin',
  /*
   * #438 — the whole sources area, not just visibility.
   *
   * #239 stopped at `list_sources` because "the field-mapping dialog is not
   * something an agent should improvise". That reasoning was about BLIND
   * mapping and it stops holding once the remote schema is readable:
   * `discover_source_fields` returns the provider's real keys and a PROPOSED
   * mapping, and `create_source` then applies a mapping it was given. Nothing
   * here guesses — the same discover → propose → apply shape `propose_schema`
   * / `build_schema` already use for databases.
   *
   * Scopes mirror SourcesController exactly: reads are `read`, and every
   * mutation is `write` (the controller additionally requires `creator` on the
   * database, which the API enforces and this cannot loosen).
   */
  list_sources: 'read',
  list_source_providers: 'read',
  list_source_runs: 'read',
  list_youtube_channels: 'read',
  discover_source_fields: 'write',
  create_source: 'write',
  update_source: 'write',
  delete_source: 'write',
  sync_source: 'write',
  // #334: automation-rule CRUD. The AutomationsController is @RequiresScope('admin')
  // AND creator-gated on the database, so EVERY tool here — including the reads —
  // mirrors that ceiling: a read- or write-scoped token never even sees them, and
  // can therefore never create/update/delete a rule. (Automations are an admin
  // surface in this product; there is no lower-privilege read path to expose.)
  list_automations: 'admin',
  get_automation: 'admin',
  create_automation: 'admin',
  update_automation: 'admin',
  delete_automation: 'admin',
  // write (record + content mutations)
  create_record: 'write',
  update_record: 'write',
  update_record_description: 'write',
  delete_record: 'write',
  link_records: 'write',
  unlink_records: 'write',
  add_comment: 'write',
  delete_records: 'write',
  restore_records: 'write',
  duplicate_record: 'write',
  move_record: 'write',
  update_comment: 'write',
  delete_comment: 'write',
  restore_version: 'write',
  watch_record: 'write',
  attach_file: 'write',
  delete_attachment: 'write',
  run_button: 'write',
  run_skill: 'write',
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
  // #400/#397 — both PATCH endpoints already existed and neither had a tool, so
  // a description was settable over HTTP and not over MCP. Same admin ceiling as
  // their controllers (`@MinRole('admin')` on the workspace, `@RequiresScope('admin')`
  // on the space).
  update_space: 'admin',
  // #416 — admin, and destructive: the API refuses it without the typed name
  // whenever the space still holds databases (#417).
  delete_space: 'admin',
  update_workspace: 'admin',
  // #394 — schema building. Same admin ceiling as create_database, and the
  // ArchitectController is admin-gated for the same reason: building a workflow
  // IS schema work.
  propose_schema: 'admin',
  build_schema: 'admin',
  install_pack: 'admin',
  // A batch write is a WRITE, not schema — same scope as create_record. The
  // count is not what decides the privilege.
  create_records: 'write',
  update_records: 'write',
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
    // Wired in HERE, the one place every tool is registered, for the same reason
    // rejectUnknownArgs is: no tool gets to be the strict one, and a client that
    // stringifies arguments works uniformly instead of on whichever tools
    // happened to declare only strings.
    const coerced = { ...config, inputSchema: coerceInputSchema(config.inputSchema) };
    server.registerTool(name as string, coerced as never, rejectUnknownArgs(name, coerced, handler) as never);
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
        'VIEWS: describe_database returns each view\'s id, filter and sorts. Pass query_records a `view` to get exactly what that view shows — a shared ?view=<uuid> link works directly (#332).',
        'WRITE: describe_database first, then create_record / update_record. Fill the FULL field template, not just a couple of fields.',
        /*
         * #406 — advertised here for the same reason #393 says the bulk tools
         * are: a tool nobody is told about does not exist in practice. These
         * close the write-but-never-read gaps specifically (deleting with no
         * trash, commenting with no thread), so the line is written as the
         * read/undo counterpart to the WRITE line above rather than as a list.
         */
        'AROUND A RECORD: list_records = the hand-arranged order query_records cannot express. get_history = who changed what (kind: fields/versions/activity) and restore_version rolls one back. list_comments reads the thread you post to with add_comment; list_trash + restore_records undo a delete_record (30 days). Also duplicate_record, move_record (kanban drop: after + values), list_backlinks, list_watchers / watch_record.',
        /*
         * #394 — the bulk path is FIRST, because an unadvertised bulk tool is
         * the same discoverability failure as #393. A session that did not know
         * these existed made ninety sequential add_field calls and reported
         * managing our round-trip cost as its main constraint.
         */
        'BUILD (fast): list_packs → install_pack for a ready-made workspace, or propose_schema → show the plan → build_schema to create many databases/fields/relations in ONE call. Prefer these over a long create_database/add_field sequence.',
        'BUILD (manual, for one-off additions): list_spaces → create_space → create_database → add_field → create_view → create_relation. Then create_records (batch, up to 100) to populate.',
        /*
         * #393 — this compressed list is what a reviewer skimmed past before
         * concluding rules could not email or call an API. Naming the three
         * outward capabilities in words costs one line and is the whole fix.
         */
        'AUTOMATE (admin): describe_database first, then create_automation = trigger (record_created/_updated/_linked, schedule, or webhook_received) + optional condition (a query_records-style filter) + 1–10 actions. ' +
        'Rules REACH OUTSIDE StoryOS — they can send real email, call any public HTTP API, and post to Slack, from scheduled and triggered rules alike, not just from buttons. ' +
        'Actions: set/create/create_records/comment/notify/send_email/send_webhook/http_request/send_slack_message/run_agent. ' +
        // #297: these all shipped and worked, but nothing an agent reads mentioned
        // them — so in practice they did not exist.
        'A record_linked trigger takes direction:"link"|"unlink" (omit = both). EVERY action takes an optional `condition` — a non-match skips just that action. ' +
        'Template tokens: {Field Name} · {linked.Field Name} (the just-linked record) · {changesSummary} → "State: Urgent → Done" · {index} inside create_records. ' +
        'list_automations / get_automation read them back with names AND ids; update_automation enables/disables or edits (it replaces a trigger WHOLE — read first, pass back what you keep); delete_automation needs confirm=true; get_runs shows why a rule did or didn\'t fire.',
        '',
        'Refs: address a database by its qualified "space/database" slug (from list_databases) — a bare name that exists in two spaces is rejected. Never invent ids; they come from search / list_* / a prior result. Names, slugs and select labels are resolved server-side.',
        'Values: select/multi_select take the human label (e.g. "High"); rich_text fields accept Markdown (headings, lists, links, code — parsed to blocks) and are returned to you as Markdown.',
        '',
        '"Description": a record\'s own rich-text description (the block editor content under its title) is NOT a values key — writing values.description 422s unless the database happens to have a real custom field by that name. Use get_record_description / update_record_description (also Markdown in/out) for the record\'s document body.',
        '',
        'Links: get_record / query_records / create_record / update_record all include a `url` — a clickable web-app link for that record, ready to hand to a user. Scheme: {web origin}/w/{workspace_id}/d/{database_id}/r/{title-slug}-{number} (falls back to the record uuid when it has no public number yet). workspace_id/database_id are the ids from list_workspaces/list_databases — never the human name/slug you passed in. Use get_links to resolve a database or view link, or a batch of record links, without a round-trip per record.',
        '',
        `SCOPE: ${scopeExclusions(effective)}`,
        '',
        // #365 — stated HERE because this is the tool an agent is told to call
        // first, so the reconnect rule is in front of whoever is about to write.
        // It was already in #343's PR description and the docs sweep, and that
        // did not help: knowing it in advance is not the same as reading it at
        // the moment writes start failing.
        SCHEMA_VERSION_NOTICE,
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
      description: 'Every workspace the token can access (id, name, role, description).',
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
        dbs.map((d) => ({
          id: d.id,
          name: d.name,
          ref: d.qualifiedSlug ?? d.apiSlug,
          space: d.spaceSlug ?? null,
          // #400: omitted entirely when unset. An explicit `description: null` on
          // every row is noise in a listing an agent reads on every task, and
          // "absent" already reads as "nobody has said".
          ...(d.description ? { description: d.description } : {}),
        })),
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
        /* #400 — what this table is FOR. A one-liner here tells a reader more
           than fifteen field definitions do, and it is the difference between an
           agent choosing a target database by purpose and guessing from its name. */
        description: detail.description ?? undefined,
        ref: detail.qualifiedSlug ?? undefined,
        space: detail.spaceSlug ?? undefined,
        my_access: detail.my_access,
        fields: describeFields(detail),
        /*
         * #332 — the view's ID is included, not just its name.
         *
         * Without it a shared view URL (`?view=<uuid>`) could not be mapped back
         * to anything: the id was in hand here and dropped on the way out, while
         * `resolveView` below has always ACCEPTED an id. So the product could
         * consume a view id it refused to emit, and "work everything in this
         * view" needed a human to translate the link into a name first.
         *
         * `filter`/`sorts` come along when the view has them, so an agent can say
         * what a view selects — and reuse the same AST with query_records —
         * rather than guessing from the name.
         */
        views: (detail.views ?? []).map((v) => {
          const config = (v.config ?? {}) as { filter?: unknown; sorts?: unknown };
          return {
            id: v.id,
            name: v.name,
            type: v.type,
            ...(config.filter ? { filter: config.filter } : {}),
            ...(Array.isArray(config.sorts) && config.sorts.length ? { sorts: config.sorts } : {}),
          };
        }),
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

  /*
   * #404 — counting must not be done by fetching.
   *
   * "How many contacts do we have?" pulled 148 rows x 22 columns through a
   * 128k context window and failed at 136,922 tokens. Worse than the crash: when
   * the fetch DOES fit, the model counts one PAGE and reports it as the total —
   * a confidently wrong number, which is #401's failure by another route.
   *
   * Registered BEFORE query_records so a model scanning the tool list meets the
   * cheap, correct way to answer "how many" before it meets the expensive one.
   */
  reg(
    'count_records',
    {
      title: 'Count records',
      description:
        'Count records in a database, or total/average a numeric field — computed in the database, ' +
        'returning one number. USE THIS FOR ANY "how many" QUESTION rather than fetching records and ' +
        'counting them: query_records is paginated, so counting its results gives you the size of one ' +
        'page, not the total. Takes the same filter AST as query_records, so "how many are still open" ' +
        'is one call.',
      inputSchema: {
        workspace: z.string(),
        database: z.string().describe('Database name, api slug, or id.'),
        op: z
          .enum(['count', 'sum', 'avg', 'min', 'max'])
          .optional()
          .describe('Default "count". The others need `field` and aggregate its numeric values.'),
        field: z.string().optional().describe('Field api_name to aggregate. Required for everything except count.'),
        filter: z.any().optional().describe('Same filter AST as query_records — see get_started.'),
        q: z.string().optional().describe('Free-text match on the title, same as query_records.'),
      },
    },
    handle<{ workspace: string; database: string; op?: string; field?: string; filter?: unknown; q?: string }>(
      async ({ workspace, database, op, field, filter, q }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const res = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/aggregate', {
            params: { path: { ws: ws.id, db: db.id } },
            body: { op: op ?? 'count', field, filter, q } as never,
          }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'query_records',
    {
      title: 'Query records',
      description:
        'List/filter/sort records in a database. filter is the structured AST (see get_started for the ' +
        'full op cheat-sheet). Both a grouped filter — { "and": [{ "field": "priority", "op": "eq", ' +
        '"value": "Urgent" }] } — and a bare single condition — { "field": "priority", "op": "eq", ' +
        '"value": "Urgent" } — are accepted; no group wrapper is required for one condition. Returns ' +
        'compact records + next_cursor for pagination.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        filter: z
          .any()
          .optional()
          .describe(
            'Filter AST — grouped { and: [{ field, op, value }] }/{ or: [...] }, or a bare ' +
              '{ field, op, value } condition. Example: { "field": "priority", "op": "eq", "value": "Urgent" }. ' +
              'See get_started for the op-by-field-type cheat sheet.',
          ),
        sorts: z
          .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }))
          .optional()
          .describe('Sort keys by field api_name.'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe('next_cursor from a prior call.'),
        /*
         * #332 step 3 — "the records in this view", in one call.
         *
         * The natural instruction a person gives is a LINK: they paste
         * `?view=<uuid>` and say "work everything in here". Until now that
         * needed a human to translate the link into a filter by hand.
         */
        view: z
          .string()
          .optional()
          .describe(
            'View id or name — applies that view\'s saved filter and sorts, so "the records in this view" matches what the UI shows. A `view` URL\'s ?view=<uuid> works directly. Your own `filter`/`sorts` override the view\'s.',
          ),
      },
    },
    handle<{
      workspace: string;
      database: string;
      filter?: unknown;
      sorts?: unknown;
      limit?: number;
      cursor?: string;
      view?: string;
    }>(
      async ({ workspace, database, filter, sorts, limit, cursor, view }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        // Read the schema first so select labels in the filter can be resolved (#77).
        const detail = await getDetail(ws.id, db.id);

        /*
         * #332 — the view's saved scope.
         *
         * The ticket held this back because "a view filter can reference `me`,
         * and a personal view (#291) is private to its owner, so it must resolve
         * against the CALLING identity and refuse someone else's personal view."
         * Both are satisfied WITHOUT any check written here, and that is the
         * point rather than an oversight:
         *
         *  - The view comes from the database-detail payload, fetched with the
         *    CALLER's own token, and that query now carries
         *    `notOthersPersonalView` — so another member's personal view is not
         *    in the payload to resolve against. (It was missing there until this
         *    change; see the comment in DatabasesService.get. The MCP is not a
         *    privileged path (ADR-0016), so it inherits the rule rather than
         *    re-implementing it — re-implementing it here would be the leak.)
         *  - `me` is resolved by the API's query compiler against
         *    `ctx.currentUserId` — the authenticated caller. Passing the AST
         *    through unexpanded is therefore not just safe but REQUIRED:
         *    resolving `me` here would freeze it to whoever happened to ask.
         *
         */
        let viewFilter: unknown;
        let viewSorts: unknown;
        if (view) {
          // Resolved from the detail already fetched above — no extra round trip,
          // and it inherits that endpoint's access filtering rather than
          // re-deriving it here.
          const resolved = resolveView(detail, view);
          const cfg = (resolved.config ?? {}) as { filters?: unknown; sorts?: unknown };
          viewFilter = cfg.filters;
          viewSorts = cfg.sorts;
        }

        // An explicit argument wins over the view's saved one — "this view, but
        // only the overdue ones" has to be expressible.
        const effectiveFilter = filter ?? viewFilter;
        const effectiveSorts = sorts ?? viewSorts;

        const res = await unwrap<{ data: RecordRow[]; next_cursor: string | null; has_more: boolean }>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
            params: { path: { ws: ws.id, db: db.id } },
            body: {
              filter: mapFilterValues(detail, effectiveFilter),
              sorts: effectiveSorts ?? [],
              limit: limit ?? 50,
              cursor,
            } as never,
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
      return text(serializeRecord(detail, ws.id, db.id, row));
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
      // #172: workflow is single-select-shaped — resolve its label → id like select.
      if ((f.type === 'select' || f.type === 'workflow') && typeof value === 'string') out[key] = toId(value);
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
      // #172: workflow reads back to its label like select (single option id).
      if (f.type === 'select' || f.type === 'workflow') out[k] = typeof v === 'string' ? toLabel(v) : v;
      else if (f.type === 'multi_select' && Array.isArray(v)) out[k] = v.map(toLabel);
    }
    return out;
  }

  /**
   * #343 — THE one record shape. Every tool that hands back a record goes through
   * here, so a record looks the same however you touched it.
   *
   * They used to disagree in three ways, all of them the write path skipping some
   * of what `get_record` did: `link_records`/`unlink_records` returned the raw row
   * (select values as option UUIDs, rich_text as BlockNote block JSON, no `url`),
   * and `create_record`/`update_record` labelized but returned the WRITE response,
   * which carries no relation chips — so a record's `epic` vanished from the echo
   * of an update that never touched it. Nothing was lost, but a response you cannot
   * tell apart from data loss forces a re-read to find out, every time.
   */
  function serializeRecord(detail: DatabaseDetail, wsId: string, dbId: string, row: RecordRow) {
    return { ...row, values: labelize(detail, row.values), url: recordUrl(wsId, dbId, row) };
  }

  /**
   * Read a record back through the SAME GET `get_record` uses, then serialise it.
   *
   * Write endpoints do not hydrate relations, so a write tool that echoes its own
   * response is structurally unable to match a read. Re-reading costs one request
   * and makes that whole class of divergence impossible, rather than asking four
   * call sites to remember to stay in step.
   */
  async function readRecord(detail: DatabaseDetail, wsId: string, dbId: string, recId: string) {
    const row = await unwrap<RecordRow>(
      client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', { params: { path: { ws: wsId, db: dbId, rec: recId } } }),
    );
    return serializeRecord(detail, wsId, dbId, row);
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
          body: { values: mapWriteValues(detail, parseStructuredParam(values, 'values') as Record<string, unknown>) } as never,
        }),
      );
      // Read back rather than echoing the write response — that is what carries the
      // relation chips, so a record created WITH links shows them (#343).
      const record = await readRecord(detail, ws.id, db.id, row.id);
      const unset = unsetFields(detail, values);
      // A record with no title is a real outcome worth naming: it is unfindable by
      // search and reads as blank in every list. Silence here is what let #343
      // itself be filed nameless.
      const untitled = !String(record.title ?? '').trim();
      const notes = [
        untitled
          ? 'This record has NO TITLE — it will show as blank everywhere. The title is values.name; set it with update_record.'
          : null,
        unset.length
          ? `Left empty — if relevant to this record, fill them: ${unset.join(', ')}. Call describe_database to see each field.`
          : null,
      ].filter(Boolean);
      return text(
        notes.length
          ? { record, ...(unset.length ? { unset_fields: unset } : {}), note: notes.join(' ') }
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
        await unwrap<RecordRow>(
          client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
            params: { path: { ws: ws.id, db: db.id, rec } },
            body: { values: mapWriteValues(detail, parseStructuredParam(values, 'values') as Record<string, unknown>) } as never,
          }),
        );
        // Read back: the PATCH response carries no relation chips, so echoing it
        // dropped `epic`/`parent`/… from an update that never touched them (#343).
        return text(await readRecord(detail, ws.id, db.id, rec));
      },
    ),
  );

  // ---- Record description (#280): the record's own rich document body — GET/PUT
  // .../records/:rec/document — is a SEPARATE thing from an ordinary custom field
  // that happens to be named "description". `values.description` in create_record/
  // update_record only ever reaches a real field of that name (and 422s if none
  // exists); these two tools are the only way to reach the document body. Content
  // round-trips as Markdown, exactly like a rich_text field (blocksToMarkdown /
  // markdownToBlocks) — never raw BlockNote block JSON. ----

  reg(
    'get_record_description',
    {
      title: "Get record's description (document body)",
      description:
        "The record's own rich-text description/document — the block editor content shown under its title, NOT a custom field literally named \"description\" (that would show up in get_record's values instead, if the database has one). Returns Markdown. version 0 means it has never been written.",
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
      },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      const doc = await unwrap<{ record_id: string; content: unknown; version: number; updated_at: string | null }>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document', {
          params: { path: { ws: ws.id, db: db.id, rec } },
        }),
      );
      return text({
        content: Array.isArray(doc.content) ? blocksToMarkdown(doc.content) : '',
        version: doc.version,
        updated_at: doc.updated_at,
      });
    }),
  );

  reg(
    'update_record_description',
    {
      title: "Set record's description (document body)",
      description:
        "Overwrite the record's rich-text description/document — the block editor content shown under its title, NOT a custom field literally named \"description\" (use update_record's values for that). content is Markdown (headings/lists/links parsed into real blocks, same as a rich_text field). Omit expected_version to overwrite unconditionally; pass the version from a prior get_record_description to fail safely (409) if it changed since you read it.",
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        content: z.string().describe('Markdown. An empty string clears the description.'),
        expected_version: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Optimistic-concurrency guard. Omit to overwrite regardless of the current version.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; content: string; expected_version?: number }>(
      async ({ workspace, database, record, content, expected_version }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const version =
          expected_version ??
          (
            await unwrap<{ version: number }>(
              client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document', {
                params: { path: { ws: ws.id, db: db.id, rec } },
              }),
            )
          ).version;
        const doc = await unwrap<{ record_id: string; content: unknown; version: number; updated_at: string | null }>(
          client.PUT('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document', {
            params: { path: { ws: ws.id, db: db.id, rec } },
            body: { content: markdownToBlocks(content), expected_version: version } as never,
          }),
        );
        return text({ content, version: doc.version, updated_at: doc.updated_at });
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
        // Was `text(row)` — the RAW row: option UUIDs instead of labels, BlockNote
        // JSON instead of prose, no `url`. Same serialiser as every other tool (#343).
        return text(await readRecord(detail, ws.id, db.id, rec));
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
        // Was `text(row)` — the RAW row: option UUIDs instead of labels, BlockNote
        // JSON instead of prose, no `url`. Same serialiser as every other tool (#343).
        return text(await readRecord(detail, ws.id, db.id, rec));
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

  /* =====================================================================
   * #406 areas 1–3 — the record surface an agent actually works on.
   *
   * The audit that produced #406 counted 110 REST operations with no tool. Its
   * own sequencing note put these three areas first, and the reason is the
   * asymmetry rather than the count: `delete_record` existed with no way to see
   * or undo the trash, `add_comment` existed with no way to read a comment back,
   * and `query_records` could sort by any field except the order a human had
   * dragged records into. Each of those is a half-built capability, which is
   * worse than a missing one — an agent finds the write, uses it, and cannot
   * check its own work.
   * ===================================================================== */

  // ---- Area 1: record lifecycle (trash, restore, duplicate, reposition) ----

  /**
   * Trashed records are invisible to /records/by-number — it filters
   * `deletedAt IS NULL` — so a public number stops resolving the moment a record
   * is deleted. Resolve against the trash listing instead. (That listing returns
   * `number` as of this ticket; it previously returned id/title/deleted_at only,
   * which left no path at all from "restore #42" to a record id.)
   */
  async function resolveTrashedRecordId(wsId: string, dbId: string, ref: string): Promise<string> {
    const t = ref.trim();
    if (!/^\d+$/.test(t)) return t;
    const trash = await unwrap<{ data: Array<{ id: string; number: number | null; title: string }> }>(
      client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/trash', { params: { path: { ws: wsId, db: dbId } } }),
    );
    const hit = trash.data.find((r) => String(r.number) === t);
    if (!hit) {
      throw new Error(
        `No record #${t} in the trash. Call list_trash to see what is restorable — deletion is reversible for 30 days, after which the record is gone.`,
      );
    }
    return hit.id;
  }

  reg(
    'list_trash',
    {
      title: 'List trash',
      description:
        'The deleted records of a database, newest first — restorable for 30 days, then gone for good. Call this before restore_records (a deleted record no longer resolves by public number anywhere else) and after a delete you are unsure about.',
      inputSchema: { workspace: z.string(), database: z.string() },
    },
    handle<{ workspace: string; database: string }>(async ({ workspace, database }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const trash = await unwrap<{ data: Array<{ id: string; number: number | null; title: string; deleted_at: string | null }> }>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/trash', { params: { path: { ws: ws.id, db: db.id } } }),
      );
      return text({ records: trash.data, retention_days: 30, restore_with: 'restore_records' });
    }),
  );

  reg(
    'delete_records',
    {
      title: 'Delete records',
      description:
        'Move up to 200 records to trash in one call (restorable 30 days via list_trash / restore_records). Records are uuids or public numbers. Use delete_record for a single one — this exists so cleaning up a query result is one call instead of two hundred.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        records: z.array(z.string()).min(1).max(200).describe('Record uuids or public numbers.'),
      },
    },
    handle<{ workspace: string; database: string; records: string[] }>(async ({ workspace, database, records }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const ids = await Promise.all(records.map((r) => resolveRecordId(ws.id, db.id, r)));
      const res = await unwrap<{ deleted: number }>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/batch-delete', {
          params: { path: { ws: ws.id, db: db.id } },
          body: { record_ids: ids } as never,
        }),
      );
      // The API only trashes rows that were live, so `deleted` can be lower than
      // what was asked for — reported rather than smoothed over, because a silent
      // shortfall reads as success (#343's lesson applied to a batch).
      return text({ ...res, requested: ids.length, restorable_for_days: 30 });
    }),
  );

  reg(
    'restore_records',
    {
      title: 'Restore records',
      description:
        'Bring records back from the trash. Pass uuids or public numbers — a number is resolved against the trash listing, since a deleted record no longer resolves by number anywhere else. Restoring one record returns the record; restoring several returns a count.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        records: z.array(z.string()).min(1).max(200).describe('Record uuids or public numbers (see list_trash).'),
      },
    },
    handle<{ workspace: string; database: string; records: string[] }>(async ({ workspace, database, records }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const ids = await Promise.all(records.map((r) => resolveTrashedRecordId(ws.id, db.id, r)));
      if (ids.length === 1) {
        await unwrap(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/restore', {
            params: { path: { ws: ws.id, db: db.id, rec: ids[0]! } },
          }),
        );
        const detail = await getDetail(ws.id, db.id);
        return text(await readRecord(detail, ws.id, db.id, ids[0]!));
      }
      const res = await unwrap<{ restored: number }>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/batch-restore', {
          params: { path: { ws: ws.id, db: db.id } },
          body: { record_ids: ids } as never,
        }),
      );
      return text({ ...res, requested: ids.length });
    }),
  );

  reg(
    'duplicate_record',
    {
      title: 'Duplicate record',
      description:
        'Copy a record: its values, its description document, and its single/many-to-many links. Owned collections (the "many" side a record owns) are NOT copied — a duplicated project does not clone its tasks. Returns the new record, so use it as a template-instantiation step rather than re-typing a filled-in record.',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string().describe('Record uuid or public number.') },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      const created = await unwrap<RecordRow>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/duplicate', {
          params: { path: { ws: ws.id, db: db.id, rec } },
        }),
      );
      const detail = await getDetail(ws.id, db.id);
      return text({ duplicated_from: rec, record: await readRecord(detail, ws.id, db.id, created.id) });
    }),
  );

  reg(
    'move_record',
    {
      title: 'Move record',
      description:
        'Reposition a record in the hand-arranged (manual) order — the order list_records returns and a board/list shows. Pass exactly ONE of `before` / `after` (the neighbour to land next to), optionally with `values` to change a field in the same atomic step: that pair is a kanban drop, e.g. after:"12" plus values:{state:"Done"} moves the card into Done under #12. `values` alone repositions nothing and just patches.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        before: z.string().optional().describe('Land immediately BEFORE this record (uuid or public number).'),
        after: z.string().optional().describe('Land immediately AFTER this record (uuid or public number).'),
        values: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional field patch applied atomically with the move — the column a kanban card is dropped into.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; before?: string; after?: string; values?: Record<string, unknown> }>(
      async ({ workspace, database, record, before, after, values }) => {
        if (before && after) throw new Error('Pass only one of `before` / `after` — a record lands on one side of one neighbour.');
        if (!before && !after && !values) throw new Error('Nothing to do: pass `before` or `after` to reposition, and/or `values` to patch.');
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const body: { before_record_id?: string; after_record_id?: string; values?: Record<string, unknown> } = {};
        if (before) body.before_record_id = await resolveRecordId(ws.id, db.id, before);
        if (after) body.after_record_id = await resolveRecordId(ws.id, db.id, after);
        // Same label→id / Markdown→blocks mapping every other write goes through,
        // so a kanban drop takes values:{state:"Done"} and not an option uuid.
        if (values) body.values = mapWriteValues(detail, values);
        await unwrap(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/move', {
            params: { path: { ws: ws.id, db: db.id, rec } },
            body: body as never,
          }),
        );
        return text(await readRecord(detail, ws.id, db.id, rec));
      },
    ),
  );

  // ---- Area 2: listing in MANUAL order ----

  reg(
    'list_records',
    {
      title: 'List records (manual order)',
      description:
        'Records in the hand-arranged (drag) order a human sees — the one thing query_records cannot express, since it sorts by field values and falls back to manual order only when given no sorts at all. Reach for this when the ORDER is the question ("the top three as they are arranged", "what is first on the board") and for query_records when the FILTER is. `q` does a title substring match; pass the returned next_cursor to page.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        q: z.string().optional().describe('Case-insensitive substring match on the record title.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50, max 200.'),
        cursor: z.string().optional().describe('next_cursor from a previous call.'),
      },
    },
    handle<{ workspace: string; database: string; q?: string; limit?: number; cursor?: string }>(
      async ({ workspace, database, q, limit, cursor }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const res = await unwrap<{ data: RecordRow[]; next_cursor: string | null; has_more: boolean }>(
          client.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
            params: { path: { ws: ws.id, db: db.id }, query: { q, limit, cursor } } as never,
          }),
        );
        return text({
          order: 'manual',
          records: res.data.map((r) => serializeRecord(detail, ws.id, db.id, r)),
          next_cursor: res.next_cursor,
          has_more: res.has_more,
        });
      },
    ),
  );

  // ---- Area 3: everything hanging off a record ----

  /**
   * A comment body is one of two stored shapes — the legacy segment array or a
   * BlockNote document (#180) — and neither is readable as JSON. Rendered to one
   * string here so `list_comments` answers "what did they say" rather than
   * handing back a document format for the model to reverse-engineer.
   */
  function commentToText(body: unknown): string {
    if (Array.isArray(body)) {
      return body
        .map((raw) => {
          const seg = raw as { type?: string; text?: string; user_id?: string; record_id?: string };
          if (seg.type === 'text') return seg.text ?? '';
          // A mention renders as an id, not a name: the ids are what an agent can
          // act on, and resolving them would cost a request per comment.
          if (seg.type === 'mention') return `@${seg.user_id ?? 'someone'}`;
          if (seg.type === 'record') return `#${seg.record_id ?? '?'}`;
          return '';
        })
        .join('');
    }
    if (body && typeof body === 'object' && (body as { format?: string }).format === 'blocknote') {
      const doc = (body as { doc?: unknown }).doc;
      if (Array.isArray(doc)) return blocksToMarkdown(doc as never);
    }
    return '';
  }

  reg(
    'list_comments',
    {
      title: 'List comments',
      description:
        'Read a record\'s comment thread, newest first, as plain text — including the ones you posted with add_comment. Each comment carries its id (for update_comment / delete_comment), author and timestamps.',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string().describe('Record uuid or public number.') },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      const res = await unwrap<{
        data: Array<{ id: string; body: unknown; author: { id: string; name: string }; edited_at: string | null; created_at: string }>;
      }>(client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments', { params: { path: { ws: ws.id, db: db.id, rec } } }));
      return text({
        record: rec,
        comments: res.data.map((c) => ({
          id: c.id,
          text: commentToText(c.body),
          author: c.author.name,
          author_id: c.author.id,
          created_at: c.created_at,
          edited_at: c.edited_at,
        })),
      });
    }),
  );

  reg(
    'update_comment',
    {
      title: 'Update comment',
      description:
        'Replace the text of a comment you authored (get its id from list_comments). Editing someone else\'s is refused by the API — correct a mistake of your own rather than posting a second comment that contradicts the first.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        comment: z.string().describe('Comment id from list_comments.'),
        body: z.string().describe('The replacement text — replaces the whole comment, not appended.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; comment: string; body: string }>(
      async ({ workspace, database, record, comment, body }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const res = await unwrap<{ id: string; edited_at: string | null }>(
          client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments/{comment}', {
            params: { path: { ws: ws.id, db: db.id, rec, comment } } as never,
            body: { body: [{ type: 'text', text: body }] } as never,
          }),
        );
        return text({ id: res.id, text: body, edited_at: res.edited_at });
      },
    ),
  );

  reg(
    'delete_comment',
    {
      title: 'Delete comment',
      description:
        'Delete a comment you authored (workspace admins may delete any). Get the id from list_comments. Unlike a record, a comment does not go to a trash you can browse — deleting is the end of it.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        comment: z.string().describe('Comment id from list_comments.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; comment: string }>(
      async ({ workspace, database, record, comment }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        await unwrap(
          client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/comments/{comment}', {
            params: { path: { ws: ws.id, db: db.id, rec, comment } } as never,
          }),
        );
        return text({ deleted: comment });
      },
    ),
  );

  reg(
    'get_history',
    {
      title: 'Get record history',
      description:
        'What happened to this record, newest first, through one of three lenses. kind:"fields" (default) = per-field changes with readable before/after values — use this to answer "who changed the status and when". kind:"versions" = whole-record snapshots, each with a version id you can hand to restore_version. kind:"activity" = the full trail including comments, links and attachments, not just value edits. Three lenses on one question, so pick by what you are answering rather than calling all three.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        kind: z.enum(['fields', 'versions', 'activity']).optional().describe('Default "fields".'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
        cursor: z.string().optional().describe('next_cursor from a previous call.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; kind?: 'fields' | 'versions' | 'activity'; limit?: number; cursor?: string }>(
      async ({ workspace, database, record, kind, limit, cursor }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const query = { limit, cursor };
        const path = { ws: ws.id, db: db.id, rec };
        const which = kind ?? 'fields';
        const res =
          which === 'versions'
            ? await unwrap<unknown>(
                client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions', { params: { path, query } as never }),
              )
            : which === 'activity'
              ? await unwrap<unknown>(
                  client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/activity', { params: { path, query } as never }),
                )
              : await unwrap<unknown>(
                  client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions/changes', {
                    params: { path, query } as never,
                  }),
                );
        const body = res as { data?: unknown; next_cursor?: string | null };
        return text({ record: rec, kind: which, entries: body.data ?? [], next_cursor: body.next_cursor ?? null });
      },
    ),
  );

  reg(
    'restore_version',
    {
      title: 'Restore version',
      description:
        'Roll a record back to a previously captured snapshot. Get the version id from get_history with kind:"versions". This OVERWRITES the current values with the old ones and is itself recorded as a new version, so it is undoable — but read the version first (a snapshot list gives you titles and timestamps, not values) rather than restoring blind.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        version: z.string().describe('Version id from get_history kind:"versions".'),
      },
    },
    handle<{ workspace: string; database: string; record: string; version: string }>(
      async ({ workspace, database, record, version }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        await unwrap(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions/{version}/restore', {
            params: { path: { ws: ws.id, db: db.id, rec, version } } as never,
          }),
        );
        const detail = await getDetail(ws.id, db.id);
        return text({ restored_version: version, record: await readRecord(detail, ws.id, db.id, rec) });
      },
    ),
  );

  reg(
    'list_backlinks',
    {
      title: 'List backlinks',
      description:
        'Records whose description document MENTIONS this record — the "Mentioned in" list. This is prose cross-referencing, NOT relation links: use get_record (or describe_database for the relation fields) for structural links, and this to find where a record is being talked about.',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string().describe('Record uuid or public number.') },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/backlinks', { params: { path: { ws: ws.id, db: db.id, rec } } }),
      );
      const body = res as { data?: unknown };
      return text({ record: rec, mentioned_in: body.data ?? res });
    }),
  );

  reg(
    'list_linked_records',
    {
      title: 'List linked records',
      description:
        'The full link set of ONE relation field on a record, as records you can act on (id, public number, title, url). Not to be confused with get_links, which builds web URLs: this reads relations. get_record already projects link chips, so reach for this when you need the whole set of a heavily-linked record (up to 200, title-ordered) or the target database\'s id to query it — and to verify a link_records / unlink_records call actually landed.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        relation_field: z.string().describe('The relation field on this database (api_name, name, or id).'),
      },
    },
    handle<{ workspace: string; database: string; record: string; relation_field: string }>(
      async ({ workspace, database, record, relation_field }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const fieldId = resolveFieldId(detail, relation_field, ['relation'], 'relation');
        const rec = await resolveRecordId(ws.id, db.id, record);
        const relField = detail.fields.find((f) => f.id === fieldId);
        // A self-relation has no separate target database — fall back to this one,
        // exactly as link_records does, so the urls still resolve.
        const targetDbId = relField?.relation?.target_database_id ?? db.id;
        const res = await unwrap<{ data: Array<{ id: string; title: string; number: number | null }> }>(
          client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}', {
            params: { path: { ws: ws.id, db: db.id, rec, field: fieldId } } as never,
          }),
        );
        return text({
          record: rec,
          relation_field: relField?.apiName ?? fieldId,
          target_database: { id: targetDbId, name: relField?.relation?.target_database_name ?? null },
          linked: res.data.map((r) => ({ ...r, url: recordUrl(ws.id, targetDbId, r) })),
        });
      },
    ),
  );

  reg(
    'list_watchers',
    {
      title: 'List watchers',
      description:
        'Who gets notified when this record changes, and whether the caller is among them. Read this before assuming a change will reach anyone — a record with no watchers notifies nobody except through an explicit mention.',
      inputSchema: { workspace: z.string(), database: z.string(), record: z.string().describe('Record uuid or public number.') },
    },
    handle<{ workspace: string; database: string; record: string }>(async ({ workspace, database, record }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const rec = await resolveRecordId(ws.id, db.id, record);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/watchers', { params: { path: { ws: ws.id, db: db.id, rec } } }),
      );
      return text({ record: rec, ...(res as Record<string, unknown>) });
    }),
  );

  reg(
    'watch_record',
    {
      title: 'Watch record',
      description:
        'Subscribe (or unsubscribe) the CALLING identity to a record\'s changes. Note what this is not: it cannot subscribe someone else — a token watches on behalf of whoever it belongs to. To make a person aware of a record, mention them in add_comment instead.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record: z.string().describe('Record uuid or public number.'),
        watch: z.boolean().optional().describe('true (default) to watch, false to stop watching.'),
      },
    },
    handle<{ workspace: string; database: string; record: string; watch?: boolean }>(
      async ({ workspace, database, record, watch }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const on = watch ?? true;
        const params = { path: { ws: ws.id, db: db.id, rec } };
        await unwrap(
          on
            ? client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/watch', { params })
            : client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/watch', { params }),
        );
        return text({ record: rec, watching: on });
      },
    ),
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
        field: z
          .string()
          .optional()
          .describe(
            'An attachment FIELD to put the file in (name or id), instead of the record-level bag. Use this when the record has a "Cover"/"Video" style column — a gallery card renders the FIRST file of its cover field, so upload order is the order they appear.',
          ),
      },
    },
    handle<{ workspace: string; database: string; record: string; url?: string; content_base64?: string; filename?: string; mime?: string; field?: string }>(
      async ({ workspace, database, record, url, content_base64, filename, mime, field }) => {
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

        /*
         * #391 — resolve the field by NAME as well as id, like every other tool
         * here. An agent has the schema from describe_database, where a field is
         * "Cover", not a uuid; making it paste an id would be the kind of
         * papercut that sends a session looking for a lookup tool.
         */
        let fieldId: string | undefined;
        if (field) {
          const detail = await unwrap<{ fields?: Array<{ id: string; displayName?: string; apiName?: string; type: string }> }>(
            client.GET('/api/v1/workspaces/{ws}/databases/{db}', { params: { path: { ws: ws.id, db: db.id } } }),
          );
          const match = (detail.fields ?? []).find(
            (f) =>
              f.id === field ||
              f.apiName === field ||
              f.displayName?.toLowerCase() === field.toLowerCase(),
          );
          if (!match) throw new Error(`No field "${field}" on ${db.name}.`);
          if (match.type !== 'attachment') {
            throw new Error(`Field "${field}" is a ${match.type} field, not an attachment field.`);
          }
          fieldId = match.id;
        }

        const attachment = await uploadAttachment(ctx, { ws: ws.id, db: db.id, rec }, { filename: name!, mime: type, data }, fieldId);
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

  /*
   * #394 — the bulk path. `add_field` creates ONE field, so a 90-field schema
   * was 90 sequential calls: ninety chances to fail halfway, leaving a
   * half-built database with no transaction and no obvious way to resume. The
   * capability already existed twice over (`/architect/*`, `/packs/install`) and
   * `tools.ts` referenced neither.
   *
   * ADR-0010 §6: the Architect "needs no engine privilege the CRUD API does not
   * already expose", so exposing it here grants nothing new — it stops making
   * agents do the slow thing.
   */
  reg(
    'propose_schema',
    {
      title: 'Propose a schema',
      description:
        'Turn a plain-language goal ("track clients, their projects and invoices") into a PLAN — databases, fields, relations and states, each marked create-new or reuse-existing. Creates NOTHING. Show the plan, then pass it to build_schema. This is the fast path for building a workspace: one call instead of one add_field per field.',
      inputSchema: {
        workspace: z.string(),
        goal: z.string().max(2000).describe('What the workspace is for, in plain language.'),
        mode: z
          .enum(['non_ai', 'storyos_ai', 'your_own_ai'])
          .optional()
          .describe('Omit for the free deterministic planner. "storyos_ai" is metered against this workspace\'s AI credits.'),
      },
    },
    handle<{ workspace: string; goal: string; mode?: string }>(async ({ workspace, goal, mode }) => {
      const ws = await resolveWorkspace(client, workspace);
      const plan = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/architect/propose', {
          params: { path: { ws: ws.id } } as never,
          body: { goal, ...(mode ? { mode } : {}) } as never,
        }),
      );
      return text(plan);
    }),
  );

  reg(
    'build_schema',
    {
      title: 'Build a proposed schema',
      description:
        'Build an approved plan from propose_schema in ONE call — every database, field, relation and state together, reusing existing databases where the plan says reuse. Returns a summary of what was created vs reused, with ids. Prefer this over a sequence of create_database/add_field calls.',
      inputSchema: {
        workspace: z.string(),
        plan: z
          .any()
          .describe('The plan object returned by propose_schema, passed back verbatim.'),
      },
    },
    handle<{ workspace: string; plan: unknown }>(async ({ workspace, plan }) => {
      const ws = await resolveWorkspace(client, workspace);
      /*
       * The plan goes back VERBATIM. The service re-validates it at one
       * boundary and answers a malformed plan with a 422 naming the bad part —
       * reshaping it here would turn an actionable error into a confusing one,
       * and would be a second copy of a schema that already exists.
       */
      const built = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/architect/build', {
          params: { path: { ws: ws.id } } as never,
          body: { plan } as never,
        }),
      );
      return text(built);
    }),
  );

  reg(
    'list_packs',
    {
      title: 'List packs',
      description:
        'The built-in Business Pack gallery — ready-made workspaces (databases, fields, relations, views, sample data). Installing one is the fastest possible "build me a workspace"; check here before planning a schema from scratch.',
      inputSchema: {},
    },
    handle<Record<string, never>>(async () =>
      text(await unwrap<unknown>(client.GET('/api/v1/packs/registry'))),
    ),
  );

  reg(
    'install_pack',
    {
      title: 'Install a pack',
      description:
        'Install a Business Pack by slug (from list_packs) — creates its databases, fields, relations and views in one call. Idempotent. Set preview to see exactly what it would create WITHOUT creating anything.',
      inputSchema: {
        workspace: z.string(),
        slug: z.string().describe('Pack slug from list_packs.'),
        preview: z
          .boolean()
          .optional()
          .describe('Show what would be created and create nothing. Worth doing first on a workspace that already has data.'),
      },
    },
    handle<{ workspace: string; slug: string; preview?: boolean }>(async ({ workspace, slug, preview }) => {
      const ws = await resolveWorkspace(client, workspace);
      const pack = await unwrap<{ manifest?: unknown }>(
        client.GET('/api/v1/packs/registry/{slug}', { params: { path: { slug } } as never }),
      );
      if (!pack?.manifest) throw new Error(`Pack "${slug}" has no manifest. Call list_packs for valid slugs.`);
      // Two literal calls rather than one computed path: the generated client is
      // typed per route, so a variable path erases the typing that makes a wrong
      // body a compile error rather than a 422 in production.
      const args = {
        params: { path: { ws: ws.id } } as never,
        body: { manifest: pack.manifest } as never,
      };
      return text(
        await unwrap<unknown>(
          preview
            ? client.POST('/api/v1/workspaces/{ws}/packs/preview', args)
            : client.POST('/api/v1/workspaces/{ws}/packs/install', args),
        ),
      );
    }),
  );

  /*
   * #394's other half, and the one #404 makes urgent: reading and writing
   * records one at a time is what put 130k tokens of rows through a model.
   * A batch write is one call and one response.
   */
  reg(
    'create_records',
    {
      title: 'Create records (batch)',
      description:
        'Create up to 100 records in ONE atomic call — all succeed or none do. Values are keyed by api_name exactly as create_record takes them. Use this instead of calling create_record in a loop.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        records: z
          .array(z.object({ values: z.record(z.string(), z.any()) }))
          .min(1)
          .max(100)
          .describe('Up to 100 { values } objects.'),
      },
    },
    handle<{ workspace: string; database: string; records: Array<{ values: Record<string, unknown> }> }>(
      async ({ workspace, database, records }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const res = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/batch', {
            params: { path: { ws: ws.id, db: db.id } } as never,
            // Same label/markdown/relation mapping every single-record write
            // gets — a batch that took raw ids while create_record took labels
            // would be a second, quietly different write contract.
            body: { records: records.map((r) => ({ values: mapWriteValues(detail, r.values) })) } as never,
          }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'update_records',
    {
      title: 'Update records (batch)',
      description:
        'Apply ONE set of values to up to 200 records at once — the "set status to Done for everything in this view" shape. Partial failures are reported per record rather than failing the whole call.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        record_ids: z.array(z.string()).min(1).max(200),
        values: z.record(z.string(), z.any()).describe('The patch applied to every listed record.'),
      },
    },
    handle<{ workspace: string; database: string; record_ids: string[]; values: Record<string, unknown> }>(
      async ({ workspace, database, record_ids, values }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const res = await unwrap<unknown>(
          client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/batch', {
            params: { path: { ws: ws.id, db: db.id } } as never,
            body: { record_ids, values: mapWriteValues(detail, values) } as never,
          }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'list_icon_set',
    {
      title: 'List icon set',
      description:
        'List the curated StoryOS icon names, grouped by category, as the "set:<name>" refs accepted by the icon param on create_database, update_database, create_space and update_space (#251) — plus the "brand:<slug>" third-party/product logo set (#298, e.g. "brand:github", "brand:notion") under the `brands` key. Call this before setting an icon so you pick a real name/slug.',
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
        color: z.enum(PALETTE).optional().describe(COLOR_PARAM),
        description: z.string().max(200).optional().describe(DESCRIPTION_PARAM),
      },
    },
    handle<{
      workspace: string;
      space: string;
      name: string;
      icon?: string;
      color?: string;
      description?: string;
    }>(async ({ workspace, space, name, icon, color, description }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const db = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/databases', {
          params: { path: { ws: ws.id } as never },
          body: { space_id: spaceId, name, icon, color, description } as never,
        }),
      );
      return text(db);
    }),
  );

  /*
   * #337 — `workflow` belongs here. Its absence meant an agent building a
   * database over MCP could not give it a canonical status field: the single
   * most likely field a tracker needs, and the one the product treats specially
   * (one per database, rendered by the mention badge, preferred for board
   * grouping). Every MCP-built database was therefore born with exactly the
   * `select`-instead-of-workflow debt #218 exists to pay off, and nobody found
   * out until a board would not group properly.
   */
  const FIELD_TYPES = [
    'text', 'rich_text', 'number', 'checkbox', 'date', 'select', 'multi_select', 'workflow',
    'url', 'email', 'color', 'user', 'attachment', 'lookup', 'rollup', 'button', 'formula',
  ] as const;
  /**
   * #216 — an option may carry a curated `icon` ref (`set:<name>` / `brand:<slug>`),
   * the same field the web option editor writes and every option surface draws.
   * Without it here, an agent building a database from scratch could set colours
   * but not icons, so an MCP-built workspace was visibly poorer than a
   * hand-built one — and it could not round-trip what describe_database showed it.
   */
  const optionShape = z.union([
    z.string(),
    z.object({
      label: z.string(),
      color: z.string().optional(),
      icon: z.string().max(120).optional().describe('Curated icon ref: "set:<name>" or "brand:<slug>" (see list_icon_set).'),
    }),
  ]);
  const normOptions = (o?: Array<string | { label: string; color?: string; icon?: string }>) =>
    o?.map((x) => (typeof x === 'string' ? { label: x } : x));

  reg(
    'add_field',
    {
      title: 'Add field',
      description:
        'Add a field to a database. For select/multi_select/workflow pass options as labels. Use `workflow` (not `select`) for the ' +
        'lifecycle status a database is tracked by \u2014 it is the canonical status field: at most ONE per database, and board grouping, ' +
        'the mention badge and My Work all key off it. A plain `select` is for any other list of choices. lookup/rollup/formula need config. Rollup config: {relation_field_id, op}, where op is count|sum|avg|min|max (aggregate a number field via target_field_api_name) or first|last (#286 — order the linked records by order_by_field_api_name and return that record\'s target_field_api_name, or omit it for a link to the record itself). Optional filter narrows the linked records first. (Relations link two databases — not added here yet.) Returns the field.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        name: z.string().describe('Field name, e.g. "Status".'),
        type: z.enum(FIELD_TYPES),
        options: z.array(optionShape).optional().describe('select/multi_select/workflow choices, as labels or {label,color,icon}.'),
        config: z.record(z.string(), z.any()).optional().describe('Advanced per-type config (lookup/rollup/formula).'),
      },
    },
    handle<{ workspace: string; database: string; name: string; type: string; options?: Array<string | { label: string; color?: string; icon?: string }>; config?: Record<string, unknown> }>(
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
      description:
        'Rename a field, add select options, or edit and remove existing ones. Returns the updated field. ' +
        'Editing is non-destructive: recolouring or renaming an option leaves every record that holds it untouched, ' +
        'because options have stable ids and records point at the id, not the text. ' +
        'Removing one is the exception — it refuses with a usage count unless you confirm, and can reassign holders to another option.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        field: z.string().describe('Field to update (name, api_name, or id).'),
        rename_to: z.string().optional(),
        add_options: z.array(optionShape).optional().describe('New choices to add to a select/multi_select field.'),
        /*
         * #398 — the gap that pushed a careful agent toward a DESTRUCTIVE path.
         *
         * Reported verbatim: having produced all-grey options and finding no
         * update path, a session started evaluating `change_field_type` as a
         * workaround. A missing edit path does not stop the work; it reroutes it
         * through the most dangerous tool that looks like it might do the job.
         */
        update_options: z
          .array(
            z.object({
              option: z.string().describe('Existing option, by label or id.'),
              label: z.string().max(100).optional().describe('New label.'),
              color: z.string().optional().describe('New colour, from the option palette.'),
              icon: z.string().max(120).nullable().optional().describe('Curated icon ref, or null to clear.'),
            }),
          )
          .optional()
          .describe('Recolour or rename EXISTING options. Records keep their values — ids are stable.'),
        remove_options: z
          .array(
            z.object({
              option: z.string().describe('Existing option, by label or id.'),
              confirm: z
                .boolean()
                .optional()
                .describe('Required when records still use it. Without it you get a refusal naming the count.'),
              reassign_to: z.string().optional().describe('Move holders onto this option instead of clearing them.'),
            }),
          )
          .optional()
          .describe('Delete options. Refuses with a usage count unless confirmed — read that count before confirming.'),
      },
    },
    handle<{
      workspace: string;
      database: string;
      field: string;
      rename_to?: string;
      add_options?: Array<string | { label: string; color?: string; icon?: string }>;
      update_options?: Array<{ option: string; label?: string; color?: string; icon?: string | null }>;
      remove_options?: Array<{ option: string; confirm?: boolean; reassign_to?: string }>;
    }>(
      async ({ workspace, database, field, rename_to, add_options, update_options, remove_options }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const fieldId = anyField(detail, field);

        /*
         * Options are addressed by LABEL here, resolved to an id before the call.
         * That matches the rest of this surface ("select labels are resolved
         * server-side") and it is the only workable choice: describe_database
         * shows an agent labels and colours, never option ids, so requiring an id
         * would mean asking for something the read path does not emit — the exact
         * shape of the #332 bug, one level down.
         */
        const optionsOf = () =>
          detail.fields.find((f) => f.id === fieldId)?.options ?? [];
        const resolveOption = (ref: string): string => {
          const opts = optionsOf();
          const hit =
            opts.find((o) => o.id === ref) ??
            opts.find((o) => o.label.toLowerCase() === ref.trim().toLowerCase());
          if (!hit) {
            throw new Error(
              `No option "${ref}" on that field. It has: ${opts.map((o) => o.label).join(', ') || '(none)'}.`,
            );
          }
          return hit.id;
        };
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
        for (const patch of update_options ?? []) {
          const optionId = resolveOption(patch.option);
          await unwrap<unknown>(
            client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}', {
              params: { path: { ws: ws.id, db: db.id, field: fieldId, option: optionId } } as never,
              body: {
                ...(patch.label !== undefined ? { label: patch.label } : {}),
                ...(patch.color !== undefined ? { color: patch.color } : {}),
                ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
              } as never,
            }),
          );
        }
        for (const rm of remove_options ?? []) {
          const optionId = resolveOption(rm.option);
          await unwrap<unknown>(
            client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}', {
              params: { path: { ws: ws.id, db: db.id, field: fieldId, option: optionId } } as never,
              // `confirm` defaults FALSE deliberately — the API answers an
              // unconfirmed delete with the number of records still holding the
              // option, which is precisely the sentence the user needs to see
              // before it happens. Defaulting to true would throw that away.
              body: {
                confirm: rm.confirm ?? false,
                ...(rm.reassign_to ? { reassign_to: resolveOption(rm.reassign_to) } : {}),
              } as never,
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
  type FormFieldOpt = string | { field: string; required?: boolean; label?: string; help?: string };
  type ViewOpts = {
    group_by?: string;
    card_fields?: string[];
    date_field?: string;
    start_date_field?: string;
    end_date_field?: string;
    filters?: unknown;
    sorts?: Array<{ field: string; direction?: string }>;
    form_title?: string;
    form_description?: string;
    form_submit_text?: string;
    form_fields?: FormFieldOpt[];
    form_access?: 'members' | 'link' | 'public';
    form_success_message?: string;
    form_redirect_url?: string;
  };
  function buildViewConfig(detail: DatabaseDetail, type: string, o: ViewOpts): Record<string, unknown> {
    // #191: only emit keys the caller actually passed. viewConfigSchema fills the
    // per-field defaults (sorts:[], hidden_field_ids:[], …) on parse, so create
    // still gets a complete config — and update can MERGE this partial onto the
    // existing config without clobbering settings the caller didn't touch.
    const config: Record<string, unknown> = {};
    if (o.sorts !== undefined) config.sorts = o.sorts;
    // Saved views take the same AST, so resolve select labels here too (#77).
    if (o.filters) config.filters = mapFilterValues(detail, o.filters);
    if (o.card_fields) config.card_field_ids = o.card_fields.map((f) => anyField(detail, f));
    if (type === 'board' && o.group_by) config.group_by_field_id = anyField(detail, o.group_by);
    if (type === 'calendar' && o.date_field) config.date_field_id = anyField(detail, o.date_field);
    if (type === 'timeline') {
      if (o.start_date_field) config.start_date_field_id = anyField(detail, o.start_date_field);
      if (o.end_date_field) config.end_date_field_id = anyField(detail, o.end_date_field);
    }
    if (type === 'form') {
      const access = o.form_access ?? 'members';
      const fields = (o.form_fields ?? []).map((f) => {
        const ref = typeof f === 'string' ? f : f.field;
        const field_id = anyField(detail, ref);
        if (typeof f === 'string') return { field_id };
        return {
          field_id,
          ...(f.required !== undefined ? { required: f.required } : {}),
          ...(f.label ? { label: f.label } : {}),
          ...(f.help ? { help: f.help } : {}),
        };
      });
      config.form = {
        ...(o.form_title ? { title: o.form_title } : {}),
        ...(o.form_description ? { description: o.form_description } : {}),
        ...(o.form_submit_text ? { submit_text: o.form_submit_text } : {}),
        fields,
        // link/public is unreachable without a token — generate one (same shape
        // as the web app's "Enable link" action) so the access level is usable
        // right away instead of a silently dead public view.
        ...(access !== 'members' ? { public_token: randomUUID().replace(/-/g, '') } : {}),
        access,
        ...(o.form_success_message ? { success_message: o.form_success_message } : {}),
        ...(o.form_redirect_url ? { redirect_url: o.form_redirect_url } : {}),
      };
    }
    return config;
  }
  const formFieldShape = z.union([
    z.string(),
    z.object({
      field: z.string(),
      required: z.boolean().optional(),
      label: z.string().optional(),
      help: z.string().optional(),
    }),
  ]);

  reg(
    'create_view',
    {
      title: 'Create view',
      description:
        'Create a saved view. board needs group_by (a select, a single user, or a one-to-many relation field); calendar needs date_field; timeline needs start_date_field/end_date_field; board/gallery/list show card_fields (chips on calendar); form takes form_* to build the actual public-facing form (title/fields/access) — a bare "form" type with no form_* params creates an unconfigured, members-only form.',
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
        form_title: z.string().max(200).optional().describe('form: heading shown to the visitor (defaults to the database name).'),
        form_description: z.string().max(2000).optional().describe('form: helper text shown under the title.'),
        form_submit_text: z.string().max(50).optional().describe('form: submit button label (default "Submit").'),
        form_fields: z.array(formFieldShape).optional().describe('form: which fields to show, in order — a field ref, or {field, required, label, help} for per-field overrides. Omit to fall back to card_fields.'),
        form_access: z.enum(['members', 'link', 'public']).optional().describe('form: who can open/submit it — members (signed-in only, default), link (anyone with the generated link), or public. link/public auto-generate a shareable token, returned in the result as config.form.public_token (the public URL is <web app>/f/<public_token>).'),
        form_success_message: z.string().max(500).optional().describe('form: message shown after a successful submit.'),
        form_redirect_url: z.string().url().max(500).optional().describe('form: redirect here instead of showing success_message.'),
        folder: z.string().optional().describe('#347 — put the view in this sidebar FOLDER (name or id) instead of nesting it under its database. Placement only: the view still belongs to its database. Omit to nest it under the database, which is the default.'),
      },
    },
    handle<{ workspace: string; database: string; name: string; type: string; folder?: string } & ViewOpts>(
      async ({ workspace, database, name, type, folder, ...rest }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const folderId = folder && db.spaceId ? await resolveFolder(client, ws.id, db.spaceId, folder) : undefined;
        const view = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/views', {
            params: { path: { ws: ws.id, db: db.id } },
            body: { name, type, config: buildViewConfig(detail, type, rest), ...(folderId ? { folder_id: folderId } : {}) } as never,
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
      description:
        'Rename a view or change its grouping / card fields / date fields / form config. Only the parts you pass change, but a form_* change rebuilds the whole form config from what you pass this call (it does not merge with the previous form config) — re-passing form_access on a form that already has a public/link token issues a NEW token, invalidating the old link.',
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
        form_title: z.string().max(200).optional(),
        form_description: z.string().max(2000).optional(),
        form_submit_text: z.string().max(50).optional(),
        form_fields: z.array(formFieldShape).optional(),
        form_access: z.enum(['members', 'link', 'public']).optional(),
        form_success_message: z.string().max(500).optional(),
        form_redirect_url: z.string().url().max(500).optional(),
        folder: z.string().optional().describe('#347 — move the view into this sidebar FOLDER (name or id). Pass null to move it back under its database. Placement only; the view still belongs to its database.'),
        unfile: z.boolean().optional().describe('#347 — move the view back out of its folder, to nest under its database again. Use this rather than folder:null, which MCP cannot express.'),
      },
    },
    handle<{ workspace: string; database: string; view: string; rename_to?: string; folder?: string; unfile?: boolean } & ViewOpts>(
      async ({ workspace, database, view, rename_to, folder, unfile, ...rest }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const v = resolveView(detail, view);
        const patch: Record<string, unknown> = {};
        if (rename_to) patch.name = rename_to;
        // #347 — placement. `undefined` leaves it alone; an explicit null moves the
        // view back under its database. Those are different operations, and the two
        // must stay distinguishable here exactly as they are in the API.
        if (unfile) patch.folder_id = null;
        else if (folder) {
          if (!db.spaceId) throw new Error('Cannot resolve a folder: this database has no space.');
          patch.folder_id = await resolveFolder(client, ws.id, db.spaceId, folder);
        }
        // #191: `filters` and `sorts` were MISSING here, so `update_view` with only
        // a filter never rebuilt the config → patch stayed `{}` → the service did a
        // Drizzle `.set()` with all-undefined → "no values to set" → 500. They're
        // included now. buildViewConfig returns only the keys the caller passed, and
        // we MERGE onto the existing config so an update is a true patch (editing the
        // filter no longer wipes sorts / hidden fields / grouping / form config).
        const CONFIG_KEYS = [
          'filters', 'sorts',
          'group_by', 'card_fields', 'date_field', 'start_date_field', 'end_date_field',
          'form_title', 'form_description', 'form_submit_text', 'form_fields', 'form_access',
          'form_success_message', 'form_redirect_url',
        ] as const;
        if (CONFIG_KEYS.some((k) => rest[k] !== undefined)) {
          patch.config = {
            ...((v.config ?? {}) as Record<string, unknown>),
            ...buildViewConfig(detail, v.type, rest),
          };
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

  /* =====================================================================
   * #444 (#406 area 11) — standalone documents and the folders they sit in.
   *
   * Before this, the only rich text an agent could write was attached to a
   * record: `update_record_description`, or a `rich_text` field. Prose that is
   * not ABOUT a record had nowhere to go, so an agent asked for a summary, a
   * plan or a write-up either crammed it into a record or created a database to
   * hold one page. Both are workarounds a person can see.
   *
   * Markdown in, Markdown out, like every other rich-text surface here — the
   * blocksToMarkdown/markdownToBlocks pair already does the work.
   * ===================================================================== */

  interface SpaceDocRow {
    id: string;
    space_id: string;
    folder_id?: string | null;
    title: string;
    icon: string | null;
    content?: unknown;
    version?: number;
    updated_at?: string | null;
  }

  const documentUrl = (wsId: string, docId: string) => `${webBaseUrl()}/w/${wsId}/doc/${docId}`;

  const serializeDoc = (wsId: string, d: SpaceDocRow) => ({
    id: d.id,
    title: d.title,
    icon: d.icon,
    space_id: d.space_id,
    folder_id: d.folder_id ?? null,
    ...(d.content !== undefined ? { content: Array.isArray(d.content) ? blocksToMarkdown(d.content) : '' } : {}),
    ...(d.version !== undefined ? { version: d.version } : {}),
    url: documentUrl(wsId, d.id),
  });

  /** Documents are addressed by title within a space, or by id — the same
   * name-or-id convention every other resolver here uses. Kept local rather
   * than added to resolve.ts because it needs a space to scope the name. */
  async function resolveDocumentId(wsId: string, spaceId: string, ref: string): Promise<string> {
    const res = await unwrap<{ data: SpaceDocRow[] }>(
      client.GET('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws: wsId, space: spaceId } } as never,
      }),
    );
    const list = res.data ?? [];
    const byId = list.find((d) => d.id === ref);
    if (byId) return byId.id;
    const lower = ref.trim().toLowerCase();
    const exact = list.filter((d) => d.title.toLowerCase() === lower);
    if (exact.length === 1) return exact[0]!.id;
    if (exact.length > 1) {
      throw new Error(`"${ref}" matches ${exact.length} documents in this space. Pass the document id (from list_documents).`);
    }
    throw new Error(
      `No document matches "${ref}" in this space. Available: ${list.map((d) => d.title).join(', ') || '(none)'}.`,
    );
  }

  reg(
    'list_documents',
    {
      title: 'List documents',
      description:
        'The standalone documents in a space — the pages that live in the sidebar next to databases, belonging to no record. Titles and ids only; call get_document for the text of one.',
      inputSchema: { workspace: z.string(), space: z.string().describe('Space name, slug, or id (from list_spaces).') },
    },
    handle<{ workspace: string; space: string }>(async ({ workspace, space }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const res = await unwrap<{ data: SpaceDocRow[] }>(
        client.GET('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
          params: { path: { ws: ws.id, space: spaceId } } as never,
        }),
      );
      return text({ space: spaceId, documents: (res.data ?? []).map((d) => serializeDoc(ws.id, d)) });
    }),
  );

  reg(
    'get_document',
    {
      title: 'Get document',
      description:
        'Read a standalone document as Markdown. `version` comes back with it — pass it to update_document to be told about a conflicting edit instead of silently overwriting someone.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().describe('Space the document lives in.'),
        document: z.string().describe('Document title or id (from list_documents).'),
      },
    },
    handle<{ workspace: string; space: string; document: string }>(async ({ workspace, space, document }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const docId = await resolveDocumentId(ws.id, spaceId, document);
      const doc = await unwrap<SpaceDocRow>(
        client.GET('/api/v1/workspaces/{ws}/documents/{doc}', { params: { path: { ws: ws.id, doc: docId } } } as never),
      );
      return text(serializeDoc(ws.id, doc));
    }),
  );

  reg(
    'create_document',
    {
      title: 'Create document',
      description:
        'Write a standalone page in a space — a summary, a plan, a write-up, meeting notes. Reach for this instead of inventing a database to hold one page of prose, or cramming prose into a record it is not about. `content` is Markdown (headings, lists, links, code). Optionally file it in a folder.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().describe('Space name, slug, or id (from list_spaces).'),
        title: z.string().describe('The page title, as it appears in the sidebar. Max 200 chars.'),
        content: z.string().optional().describe('Markdown body. Omit for an empty page you will fill in later.'),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
        folder: z.string().optional().describe('Folder name or id to file it under (from list_folders).'),
      },
    },
    handle<{ workspace: string; space: string; title: string; content?: string; icon?: string; folder?: string }>(
      async ({ workspace, space, title, content, icon, folder }) => {
        const ws = await resolveWorkspace(client, workspace);
        const spaceId = await resolveSpaceId(ws.id, space);
        const created = await unwrap<SpaceDocRow>(
          client.POST('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
            params: { path: { ws: ws.id, space: spaceId } } as never,
            body: { title, icon } as never,
          }),
        );
        /*
         * The create endpoint takes title and icon only — content and folder are
         * PATCH-only. Doing the second call HERE rather than making the caller
         * do it is the difference between "write a document" being one step and
         * three; an agent that stopped after create would leave an empty page
         * behind and reasonably believe it had written something.
         */
        const needsPatch = content !== undefined || folder !== undefined;
        if (!needsPatch) return text(serializeDoc(ws.id, created));

        const patch: Record<string, unknown> = { expected_version: created.version ?? 0 };
        if (content !== undefined) patch.content = markdownToBlocks(content);
        if (folder !== undefined) patch.folder_id = await resolveFolder(client, ws.id, spaceId, folder);
        const updated = await unwrap<SpaceDocRow>(
          client.PATCH('/api/v1/workspaces/{ws}/documents/{doc}', {
            params: { path: { ws: ws.id, doc: created.id } } as never,
            body: patch as never,
          }),
        );
        return text(serializeDoc(ws.id, { ...created, ...updated }));
      },
    ),
  );

  reg(
    'update_document',
    {
      title: 'Update document',
      description:
        'Change a document\'s title, icon, folder, or body. `content` REPLACES the whole body — read it with get_document and send the full new text, rather than the paragraph you meant to add. Pass the `version` you read to be told about a conflicting edit (409) instead of overwriting it; omit it and the last write wins.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().describe('Space the document lives in.'),
        document: z.string().describe('Document title or id (from list_documents).'),
        title: z.string().optional(),
        content: z.string().optional().describe('Markdown — replaces the whole body.'),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
        folder: z.string().nullable().optional().describe('Folder name or id, or null to move it to the space root.'),
        version: z.number().int().optional().describe('The version from get_document. Omit to overwrite unconditionally.'),
      },
    },
    handle<{
      workspace: string;
      space: string;
      document: string;
      title?: string;
      content?: string;
      icon?: string;
      folder?: string | null;
      version?: number;
    }>(async ({ workspace, space, document, title, content, icon, folder, version }) => {
      if (title === undefined && content === undefined && icon === undefined && folder === undefined) {
        throw new Error('Nothing to change — pass at least one of title, content, icon, folder.');
      }
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const docId = await resolveDocumentId(ws.id, spaceId, document);

      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (icon !== undefined) patch.icon = icon;
      if (folder !== undefined) patch.folder_id = folder === null ? null : await resolveFolder(client, ws.id, spaceId, folder);
      if (content !== undefined) {
        patch.content = markdownToBlocks(content);
        /*
         * A content write needs a version. Rather than refuse without one, read
         * the current version — the same read-then-write update_record_description
         * does. Supplying `version` is what turns this into a real check; the
         * fallback keeps a one-shot edit from being a two-call ritual.
         */
        patch.expected_version =
          version ??
          (
            await unwrap<{ version: number }>(
              client.GET('/api/v1/workspaces/{ws}/documents/{doc}', { params: { path: { ws: ws.id, doc: docId } } } as never),
            )
          ).version;
      }
      const updated = await unwrap<SpaceDocRow>(
        client.PATCH('/api/v1/workspaces/{ws}/documents/{doc}', {
          params: { path: { ws: ws.id, doc: docId } } as never,
          body: patch as never,
        }),
      );
      return text(serializeDoc(ws.id, updated));
    }),
  );

  reg(
    'delete_document',
    {
      title: 'Delete document',
      description:
        'Delete a standalone document. Unlike a record this does not appear in any trash you can browse, so treat it as permanent.',
      inputSchema: {
        workspace: z.string(),
        space: z.string(),
        document: z.string().describe('Document title or id (from list_documents).'),
        confirm: z.boolean().optional().describe('Must be true — a title can resolve by exact match to the wrong page.'),
      },
    },
    handle<{ workspace: string; space: string; document: string; confirm?: boolean }>(
      async ({ workspace, space, document, confirm }) => {
        const ws = await resolveWorkspace(client, workspace);
        const spaceId = await resolveSpaceId(ws.id, space);
        const docId = await resolveDocumentId(ws.id, spaceId, document);
        if (!confirm) {
          const doc = await unwrap<SpaceDocRow>(
            client.GET('/api/v1/workspaces/{ws}/documents/{doc}', { params: { path: { ws: ws.id, doc: docId } } } as never),
          );
          throw new Error(
            `Deleting "${doc.title}" is not undoable from here — there is no document trash. Call again with confirm: true.`,
          );
        }
        await unwrap(
          client.DELETE('/api/v1/workspaces/{ws}/documents/{doc}', { params: { path: { ws: ws.id, doc: docId } } } as never),
        );
        return text({ deleted: docId });
      },
    ),
  );

  // ---- Folders: the sidebar grouping documents, databases and views sit in ----

  reg(
    'list_folders',
    {
      title: 'List folders',
      description:
        'The folders in a space — the sidebar groups that documents, databases and views can be filed under. Read this before create_document\'s `folder` so you file a page in an existing group instead of inventing a near-duplicate.',
      inputSchema: { workspace: z.string(), space: z.string() },
    },
    handle<{ workspace: string; space: string }>(async ({ workspace, space }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const res = await unwrap<{ data: Array<{ id: string; name: string; icon: string | null; position?: number }> }>(
        client.GET('/api/v1/workspaces/{ws}/spaces/{space}/folders', {
          params: { path: { ws: ws.id, space: spaceId } } as never,
        }),
      );
      return text({ space: spaceId, folders: res.data ?? [] });
    }),
  );

  reg(
    'create_folder',
    {
      title: 'Create folder',
      description:
        'Add a sidebar folder to a space. Worth doing when you have just built several related things — a folder is how a person finds them later. Call list_folders first: a second "Reports" next to an existing one is worse than no folder.',
      inputSchema: {
        workspace: z.string(),
        space: z.string(),
        name: z.string().describe('Folder name, max 100 chars.'),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
      },
    },
    handle<{ workspace: string; space: string; name: string; icon?: string }>(async ({ workspace, space, name, icon }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const created = await unwrap<{ id: string; name: string; icon: string | null }>(
        client.POST('/api/v1/workspaces/{ws}/spaces/{space}/folders', {
          params: { path: { ws: ws.id, space: spaceId } } as never,
          body: { name, icon } as never,
        }),
      );
      return text(created);
    }),
  );

  reg(
    'update_folder',
    {
      title: 'Update folder',
      description: 'Rename a folder, change its icon, or move it up/down the sidebar with `position`.',
      inputSchema: {
        workspace: z.string(),
        space: z.string(),
        folder: z.string().describe('Folder name or id (from list_folders).'),
        name: z.string().optional(),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
        position: z.number().int().optional().describe('Sidebar order — lower sorts first.'),
      },
    },
    handle<{ workspace: string; space: string; folder: string; name?: string; icon?: string; position?: number }>(
      async ({ workspace, space, folder, name, icon, position }) => {
        if (name === undefined && icon === undefined && position === undefined) {
          throw new Error('Nothing to change — pass at least one of name, icon, position.');
        }
        const ws = await resolveWorkspace(client, workspace);
        const spaceId = await resolveSpaceId(ws.id, space);
        const folderId = await resolveFolder(client, ws.id, spaceId, folder);
        const updated = await unwrap<{ id: string; name: string; icon: string | null }>(
          client.PATCH('/api/v1/workspaces/{ws}/folders/{folder}', {
            params: { path: { ws: ws.id, folder: folderId } } as never,
            body: { name, icon, position } as never,
          }),
        );
        return text(updated);
      },
    ),
  );

  reg(
    'delete_folder',
    {
      title: 'Delete folder',
      description:
        'Remove a sidebar folder. Its contents are NOT deleted — documents, databases and views inside it fall back to the space root. That makes this the safe way to undo a grouping you got wrong.',
      inputSchema: {
        workspace: z.string(),
        space: z.string(),
        folder: z.string().describe('Folder name or id (from list_folders).'),
      },
    },
    handle<{ workspace: string; space: string; folder: string }>(async ({ workspace, space, folder }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const folderId = await resolveFolder(client, ws.id, spaceId, folder);
      // No confirm guard, deliberately: unlike delete_document this destroys
      // nothing — the folder's contents survive at the space root.
      await unwrap(
        client.DELETE('/api/v1/workspaces/{ws}/folders/{folder}', {
          params: { path: { ws: ws.id, folder: folderId } } as never,
        }),
      );
      return text({ deleted: folderId, note: 'Its contents moved to the space root; nothing was destroyed.' });
    }),
  );

  // ============ Relations (MN-146 fast-follow): link databases ============

  reg(
    'create_relation',
    {
      title: 'Create relation',
      description:
        'Link two databases with a relation field on each side. one_to_many: each record in `database` links to ONE record in `related_database`, and each related record gets MANY back — e.g. database=Tasks, related_database=Projects means each task has one project and each project has many tasks. many_to_many: both sides link to many. Use the space/database form for names that exist in more than one space. ' +
        // #344: a self-relation IS supported, with names you choose, and you can
        // have several of them — none of which this description said, so the
        // Parent/Sub-items defaults read like a hard-wired special case.
        'SELF-RELATION: pass the same database as `database` and `related_database` to link records to each OTHER — "Blocked by"/"Blocks", "Duplicates", a parent/child tree. Name both sides via field_name / reverse_field_name; they must differ, since both fields land on the same record. Unnamed, a one_to_many self-relation defaults to Parent / Sub-items and a many_to_many to Related / Related to — those are DEFAULTS, not a fixed hierarchy. A database can carry several self-relations at once (a Parent tree AND a Blocked by / Blocks pair).',
      inputSchema: {
        workspace: z.string(),
        database: z.string().describe('The "many" side for one_to_many (e.g. tasks). Same as related_database for a self-relation.'),
        related_database: z.string().describe('The "one" / parent side (e.g. projects). Same as database for a self-relation.'),
        type: z.enum(['one_to_many', 'many_to_many']).default('one_to_many'),
        field_name: z
          .string()
          .optional()
          .describe('Relation field name on `database` — e.g. "Blocked by". Default: the related database name, or Parent/Related for a self-relation.'),
        reverse_field_name: z
          .string()
          .optional()
          .describe('Inverse field name on `related_database` — e.g. "Blocks". Default: this database name, or Sub-items/Related to for a self-relation. Must differ from field_name on a self-relation.'),
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

  /* =====================================================================
   * #445 (#406 area 12) — relation CONFIGURATION.
   *
   * create_relation/delete_relation shipped long ago, so an agent could build
   * the wiring and never set the rules that make it fill itself in. That gap
   * costs most in exactly the moment an agent is most useful: create_records
   * writes 100 rows in one call (#394) and every relation on them then has to
   * be linked one at a time.
   *
   * Relations are addressed by DATABASE + RELATION FIELD, not by a bare uuid.
   * The id was reachable — the database detail returns `relation.id` — but
   * nothing in the MCP surfaced it, so delete_relation's "id from a
   * describe_database relation field" was advice an agent could not follow.
   * ===================================================================== */

  /** Resolve a relation by the field that carries it, falling back to a raw id. */
  function resolveRelationId(detail: DatabaseDetail, ref: string): string {
    const direct = detail.fields.find((f) => f.relation?.id === ref);
    if (direct) return direct.relation!.id!;
    const lower = ref.trim().toLowerCase();
    const f = detail.fields.find(
      (x) => x.relation && (x.apiName.toLowerCase() === lower || x.displayName.toLowerCase() === lower),
    );
    if (f?.relation?.id) return f.relation.id;
    // A uuid we could not match still gets passed through — the caller may hold
    // an id from create_relation, whose database may not be the one named here.
    if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
    const avail = detail.fields.filter((x) => x.relation).map((x) => x.apiName);
    throw new Error(`No relation field matches "${ref}" on this database. Available: ${avail.join(', ') || '(none)'}.`);
  }

  reg(
    'list_relations',
    {
      title: 'List relations',
      description:
        'The whole relation graph of a workspace in one call — what is connected to what, one entry per relation with both sides resolved (database and field name on each). ' +
        'READ THIS BEFORE structural work: adding a field, moving a database, planning a migration, or answering "what would break if I deleted this". The alternative is describe_database on every database and de-duplicating the two sides of each relation by hand, which is what this replaces. ' +
        'A self-relation appears ONCE with both its field names. Narrow with `space` or `database` when a workspace is large.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().optional().describe('Only relations touching this space (name, slug, or id).'),
        database: z.string().optional().describe('Only relations touching this database (name, qualified slug, or id).'),
      },
    },
    handle<{ workspace: string; space?: string; database?: string }>(async ({ workspace, space, database }) => {
      const ws = await resolveWorkspace(client, workspace);
      const query: Record<string, string> = {};
      if (space) query.space = await resolveSpaceId(ws.id, space);
      if (database) query.database = (await resolveDatabase(client, ws.id, database)).id;
      const res = await unwrap<{ data: unknown[] }>(
        client.GET('/api/v1/workspaces/{ws}/relations', { params: { path: { ws: ws.id }, query } as never }),
      );
      return text({
        relations: res.data,
        // Said explicitly because a short list can otherwise read as "there is
        // nothing else", when it may mean "there is nothing else you can see".
        note: 'Only relations whose BOTH databases you can read are listed.',
      });
    }),
  );

  reg(
    'get_relation',
    {
      title: 'Get relation',
      description:
        "A relation's configuration: both sides, its cardinality, its auto-link rules if any, and — the part worth reading — the COMPARABLE FIELDS on each side. Those are the fields set_auto_link will accept, so read this before writing a rule rather than guessing a pairing the server will reject.",
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        relation: z.string().describe('The relation FIELD on this database (name or api_name), or a relation id.'),
      },
    },
    handle<{ workspace: string; database: string; relation: string }>(async ({ workspace, database, relation }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const rel = resolveRelationId(detail, relation);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/relations/{rel}', { params: { path: { ws: ws.id, rel } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'set_auto_link',
    {
      title: 'Set auto-link rules',
      description:
        'Teach a relation to link itself: give it field pairs, and a record on one side links to a record on the other whenever ALL the pairs match — e.g. this database\'s `customer_email` equals the target\'s `email`. Setting a rule does NOT link anything that already exists; call run_auto_link for that. Pass clear:true to remove the rules. Read get_relation first for the comparable fields on each side; an empty value never matches, and matching is case-insensitive unless you say otherwise.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        relation: z.string().describe('The relation FIELD on this database (name or api_name), or a relation id.'),
        conditions: z
          .array(z.object({ field_a: z.string(), field_b: z.string() }))
          .optional()
          .describe('1–5 field pairs. field_a is on THIS database, field_b on the target. Names or ids.'),
        case_sensitive: z.boolean().optional().describe('Default false.'),
        clear: z.boolean().optional().describe('Remove the auto-link rules entirely.'),
      },
    },
    handle<{
      workspace: string;
      database: string;
      relation: string;
      conditions?: Array<{ field_a: string; field_b: string }>;
      case_sensitive?: boolean;
      clear?: boolean;
    }>(async ({ workspace, database, relation, conditions, case_sensitive, clear }) => {
      if (!clear && !conditions?.length) throw new Error('Pass `conditions` to set a rule, or clear: true to remove one.');
      if (clear && conditions?.length) throw new Error('Pass either `conditions` or clear: true, not both.');
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const rel = resolveRelationId(detail, relation);
      const res = await unwrap<unknown>(
        client.PATCH('/api/v1/workspaces/{ws}/relations/{rel}', {
          params: { path: { ws: ws.id, rel } } as never,
          body: { auto_link: clear ? null : { conditions, case_sensitive: case_sensitive ?? false } } as never,
        }),
      );
      return text({
        ...(res as Record<string, unknown>),
        note: clear ? 'Auto-link rules removed. Existing links were left alone.' : 'Rule saved. Existing records are NOT linked yet — call run_auto_link.',
      });
    }),
  );

  reg(
    'run_auto_link',
    {
      title: 'Run auto-link',
      description:
        'Apply a relation\'s auto-link rules to the records that already exist, and return a summary of what got linked. This is the tool that pays for itself after an import: create_records writes 100 rows in one call, and this links them in one more instead of a hundred link_records calls. Needs a rule set first (set_auto_link).',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        relation: z.string().describe('The relation FIELD on this database (name or api_name), or a relation id.'),
      },
    },
    handle<{ workspace: string; database: string; relation: string }>(async ({ workspace, database, relation }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const rel = resolveRelationId(detail, relation);
      const res = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/relations/{rel}/auto-link', { params: { path: { ws: ws.id, rel } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'find_select_drift',
    {
      title: 'Find select↔relation drift',
      description:
        'Find records that LOOK linked and are not: children whose select-field label matches a parent record\'s title, but which carry no actual link. This is the residue of a workspace that used a select column before it had a relation — the labels still read correctly to a human while every rollup, filter and linked view silently misses them. Reports only; fix_select_drift does the linking.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        relation: z.string().describe('The relation FIELD on this database (name or api_name), or a relation id.'),
        record: z.string().describe('The PARENT record (uuid or public number) to check for drifted children.'),
      },
    },
    handle<{ workspace: string; database: string; relation: string; record: string }>(
      async ({ workspace, database, relation, record }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const rel = resolveRelationId(detail, relation);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const res = await unwrap<unknown>(
          client.GET('/api/v1/workspaces/{ws}/relations/{rel}/select-drift', {
            params: { path: { ws: ws.id, rel }, query: { record_id: rec } } as never,
          }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'fix_select_drift',
    {
      title: 'Fix select↔relation drift',
      description:
        'Link every currently-drifted child to the parent, in one call. Run find_select_drift first and show the list — this writes links to records the caller has not named individually, so "it matched on a label" is worth a person seeing before it happens rather than after.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        relation: z.string(),
        record: z.string().describe('The PARENT record (uuid or public number).'),
      },
    },
    handle<{ workspace: string; database: string; relation: string; record: string }>(
      async ({ workspace, database, relation, record }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const rel = resolveRelationId(detail, relation);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const res = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/relations/{rel}/select-drift/reconcile', {
            params: { path: { ws: ws.id, rel } } as never,
            body: { record_id: rec } as never,
          }),
        );
        return text(res);
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

  /* =====================================================================
   * #446 (#406 area 13) — the rest of the pack surface, plus templates.
   *
   * #394 exposed the registry and install/preview. The gap that actually cost
   * something was "what is already installed": install_pack could be called
   * against a workspace that already had that pack, and nothing let an agent
   * check first — a duplicate-schema hazard, not a missing nicety.
   *
   * export_pack is the other half of the loop: an agent that has just built a
   * workspace can turn it into something installable, which is the point of
   * packs existing at all.
   * ===================================================================== */

  reg(
    'list_installed_packs',
    {
      title: 'List installed packs',
      description:
        'What is already installed in this workspace, with the install id uninstall_pack needs. CHECK THIS BEFORE install_pack: installing a pack a workspace already has creates a second copy of its databases, which reads to the user as the agent duplicating their schema.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/packs/installed', { params: { path: { ws: ws.id } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'uninstall_pack',
    {
      title: 'Uninstall pack',
      description:
        'Remove a tracked pack install. Get the install id from list_installed_packs — it is the INSTALL, not the pack slug. Read what the install covers first: uninstalling reaches the databases the pack created, and any records a person has since put in them are the part they will miss.',
      inputSchema: {
        workspace: z.string(),
        install_id: z.string().describe('Install id from list_installed_packs.'),
        confirm: z.boolean().optional().describe('Must be true — this removes schema the workspace may now be using.'),
      },
    },
    handle<{ workspace: string; install_id: string; confirm?: boolean }>(async ({ workspace, install_id, confirm }) => {
      if (!confirm) {
        throw new Error(
          'Uninstalling removes what the pack created, including anything stored in it since. Call list_installed_packs, show the user what goes, then call again with confirm: true.',
        );
      }
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/packs/{installId}/uninstall', {
          params: { path: { ws: ws.id, installId: install_id } } as never,
        }),
      );
      return text(res);
    }),
  );

  reg(
    'export_pack',
    {
      title: 'Export pack',
      description:
        'Turn part of this workspace into a pack manifest — the installable form of a schema you just built. Creates nothing; it hands back the manifest. This closes the loop packs exist for: an agent that has designed a good workspace can make it reusable instead of describing how to rebuild it.',
      inputSchema: {
        workspace: z.string(),
        databases: z
          .array(z.string())
          .optional()
          .describe('Databases to include (name, qualified slug, or id). Omit for the workspace default slice.'),
        space: z.string().optional().describe('Limit the export to one space.'),
        name: z.string().optional().describe('Name for the exported pack.'),
      },
    },
    handle<{ workspace: string; databases?: string[]; space?: string; name?: string }>(
      async ({ workspace, databases, space, name }) => {
        const ws = await resolveWorkspace(client, workspace);
        const body: Record<string, unknown> = {};
        if (name) body.name = name;
        if (space) body.space_id = await resolveSpaceId(ws.id, space);
        if (databases?.length) {
          body.database_ids = await Promise.all(
            databases.map(async (d) => (await resolveDatabase(client, ws.id, d)).id),
          );
        }
        const res = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/packs/export', { params: { path: { ws: ws.id } } as never, body: body as never }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'browse_pack_marketplace',
    {
      title: 'Browse the pack marketplace',
      description:
        'Community-published packs, as opposed to list_packs\' built-in gallery. Pass `pack` for one pack\'s manifest, changelog and versions. Worth checking alongside list_packs before building a workspace by hand — someone may have already modelled the thing being asked for.',
      inputSchema: { pack: z.string().optional().describe('Marketplace pack slug. Omit to list them all.') },
    },
    handle<{ pack?: string }>(async ({ pack }) => {
      const res = pack
        ? await unwrap<unknown>(
            client.GET('/api/v1/packs/marketplace/{slug}', { params: { path: { slug: pack } } as never }),
          )
        : await unwrap<unknown>(client.GET('/api/v1/packs/marketplace'));
      return text(res);
    }),
  );

  reg(
    'list_pack_submissions',
    {
      title: 'List pack submissions',
      description:
        "This workspace's marketplace submissions and where each stands in review. Read-only: submitting a pack is a publishing act and is not available here — see the note in coverage.ts.",
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/packs/submissions', { params: { path: { ws: ws.id } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'list_templates',
    {
      title: 'List starter templates',
      description:
        'Starter templates — smaller than a pack: a single database shape, or a space with a few. Reach for one before hand-building an ordinary shape (a CRM, a content calendar); apply_template is one call against a modelled answer.',
      inputSchema: {},
    },
    handle<Record<string, never>>(async () => {
      const res = await unwrap<unknown>(client.GET('/api/v1/templates'));
      return text(res);
    }),
  );

  reg(
    'apply_template',
    {
      title: 'Apply template',
      description:
        'Install a starter template. A pack-shaped template creates its own SPACE; a database-shaped one needs `space` and can be renamed on the way in. Templates seed sample records so the result is not an empty grid — remove_sample_data clears exactly those later, so applying one is not a decision anybody is stuck with.',
      inputSchema: {
        workspace: z.string(),
        template: z.string().describe('Template slug from list_templates.'),
        space: z.string().optional().describe('Target space — required for a database-shaped template.'),
        name: z.string().optional().describe('Rename the created database.'),
      },
    },
    handle<{ workspace: string; template: string; space?: string; name?: string }>(
      async ({ workspace, template, space, name }) => {
        const ws = await resolveWorkspace(client, workspace);
        const body: Record<string, unknown> = {};
        if (space) body.space_id = await resolveSpaceId(ws.id, space);
        if (name) body.name = name;
        const res = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/templates/{slug}/apply', {
            params: { path: { ws: ws.id, slug: template } } as never,
            body: body as never,
          }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'remove_sample_data',
    {
      title: 'Remove sample data',
      description:
        'Delete exactly the sample records a template created, and nothing a person has added since. Run it once the real data is in — sample rows left in a live database are the thing that makes a workspace look unfinished.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.DELETE('/api/v1/workspaces/{ws}/templates/sample-data', { params: { path: { ws: ws.id } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'list_spaces',
    {
      title: 'List spaces',
      description: 'List the spaces in a workspace (id, name, slug, description). Databases live in spaces; use a space name/slug with create_database.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaces = await unwrap<Array<{ id: string; name: string; slug?: string; description?: string | null }>>(
        client.GET('/api/v1/workspaces/{ws}/spaces', { params: { path: { ws: ws.id } } as never }),
      );
      return text(
        spaces.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          ...(s.description ? { description: s.description } : {}),
        })),
      );
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
        color: z.enum(PALETTE).optional().describe(COLOR_PARAM),
        description: z.string().max(200).optional().describe(DESCRIPTION_PARAM),
      },
    },
    handle<{ workspace: string; name: string; icon?: string; color?: string; description?: string }>(
      async ({ workspace, name, icon, color, description }) => {
        const ws = await resolveWorkspace(client, workspace);
        const space = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/spaces', {
            params: { path: { ws: ws.id } } as never,
            body: { name, icon, color, description } as never,
          }),
        );
        return text(space);
      },
    ),
  );

  reg(
    'update_space',
    {
      title: 'Update space',
      description:
        'Rename a space, or set its icon, colour or description. Only the fields you pass change; pass null to clear colour or description.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().describe('Space name, slug or id.'),
        rename_to: z.string().optional(),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
        color: z.enum(PALETTE).nullable().optional().describe(`${COLOR_PARAM} Pass null to clear.`),
        description: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe(`${DESCRIPTION_PARAM} Pass null to clear.`),
      },
    },
    handle<{
      workspace: string;
      space: string;
      rename_to?: string;
      icon?: string;
      color?: string | null;
      description?: string | null;
    }>(async ({ workspace, space, rename_to, icon, color, description }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const body: Record<string, unknown> = {};
      if (rename_to) body.name = rename_to;
      if (icon !== undefined) body.icon = icon;
      // `!== undefined` throughout — null is the CLEAR signal, and truthiness
      // would silently drop it.
      if (color !== undefined) body.color = color;
      if (description !== undefined) body.description = description;
      const res = await unwrap<unknown>(
        client.PATCH('/api/v1/workspaces/{ws}/spaces/{space}', {
          params: { path: { ws: ws.id, space: spaceId } } as never,
          body: body as never,
        }),
      );
      return text(res);
    }),
  );

  reg(
    'delete_space',
    {
      title: 'Delete space',
      description:
        'Permanently delete a space AND every database and record inside it. Irreversible — the trash cannot recover any of it. Guardrail: `confirm` must equal the space name exactly, the same rule delete_database enforces for a smaller action. An empty space needs no confirm.',
      inputSchema: {
        workspace: z.string(),
        space: z.string().describe('Space name, slug or id.'),
        confirm: z
          .string()
          .optional()
          .describe('Must equal the space name exactly. Required when the space still holds databases.'),
      },
    },
    handle<{ workspace: string; space: string; confirm?: string }>(async ({ workspace, space, confirm }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      /*
       * #416 — the ratchet this closes: the MCP could CREATE a space and never
       * undo the creation, so a scratch space made by an agent had to be removed
       * by hand in the browser.
       *
       * The guard is NOT implemented here. #417 put it in SpacesService.remove,
       * so an unconfirmed delete of a populated space is refused by the API with
       * a message naming the databases that would go — which is exactly why this
       * tool can exist without inventing its own safety rule. A guard living in
       * one caller is not a guard; it is a habit.
       */
      return text(
        await unwrap<unknown>(
          client.DELETE('/api/v1/workspaces/{ws}/spaces/{space}', {
            params: { path: { ws: ws.id, space: spaceId } } as never,
            body: { ...(confirm !== undefined ? { confirm } : {}) } as never,
          }),
        ),
      );
    }),
  );

  reg(
    'update_workspace',
    {
      title: 'Update workspace',
      description:
        'Rename the workspace or set its description — the top-level "what this company is doing here" line that list_workspaces returns. Only the fields you pass change.',
      inputSchema: {
        workspace: z.string(),
        rename_to: z.string().optional(),
        description: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe(`${DESCRIPTION_PARAM} Pass null to clear.`),
      },
    },
    handle<{ workspace: string; rename_to?: string; description?: string | null }>(
      async ({ workspace, rename_to, description }) => {
        const ws = await resolveWorkspace(client, workspace);
        const body: Record<string, unknown> = {};
        if (rename_to) body.name = rename_to;
        if (description !== undefined) body.description = description;
        /*
         * Deliberately NOT exposing `private_attachments`, the other key on
         * updateWorkspaceSchema. It is a security posture switch for the whole
         * workspace (#201), and "rename this workspace" is not a reason to put a
         * lever like that within reach of a model. #397's principle is that every
         * CAPABILITY is reachable, not that every field of every schema is —
         * this is a deliberate exclusion, recorded here rather than left silent.
         */
        const res = await unwrap<unknown>(
          client.PATCH('/api/v1/workspaces/{ws}', {
            params: { path: { ws: ws.id } } as never,
            body: body as never,
          }),
        );
        return text(res);
      },
    ),
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
      description: 'Rename a database, set its icon, colour or description, or move it to another space. The api_slug is stable (rename does not change the ref). Only the fields you pass change; pass null to clear colour or description.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        rename_to: z.string().optional(),
        icon: z.string().optional().describe(ICON_PARAM_DESCRIPTION),
        color: z.enum(PALETTE).nullable().optional().describe(`${COLOR_PARAM} Pass null to clear.`),
        description: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe(`${DESCRIPTION_PARAM} Pass null to clear.`),
        move_to_space: z.string().optional().describe('Space name or slug to move the database into.'),
      },
    },
    handle<{
      workspace: string;
      database: string;
      rename_to?: string;
      icon?: string;
      color?: string | null;
      description?: string | null;
      move_to_space?: string;
    }>(
      async ({ workspace, database, rename_to, icon, color, description, move_to_space }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const body: Record<string, unknown> = {};
        if (rename_to) body.name = rename_to;
        if (icon !== undefined) body.icon = icon;
        // `!== undefined`, not truthiness — null is the CLEAR signal and must
        // reach the API, where the schema is explicitly nullable.
        if (color !== undefined) body.color = color;
        if (description !== undefined) body.description = description;
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
    // #140 data-loss guard: names resolve first-match, so two order entries with
    // the same (or ambiguous) name resolve to the SAME id. Left unchecked, one
    // real item never receives a position, keeps a stale one, collides, and
    // effectively vanishes from the reordered list. Fail closed BEFORE mutating
    // anything so a lossy reorder can't half-apply — the caller uses unique names
    // or ids instead.
    if (new Set(ids).size !== ids.length) {
      throw new Error(
        `Ambiguous ${key} order: two or more names in \`order\` resolved to the same ${key} (duplicate ${key} names?). ` +
          `Pass unique names — or ids — so each ${key} maps 1:1, otherwise a ${key} would silently lose its place.`,
      );
    }
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

  // ============ Skills (#41): discover + run a workspace's saved skills ============
  // Both tools ride the exact GET/POST the in-app Skills UI uses (SkillsController),
  // so visibility (personal vs shared) and the run/last-run bookkeeping are never
  // reimplemented here — see resolve.ts's listSkills/resolveSkill.

  reg(
    'list_skills',
    {
      title: 'List skills',
      description:
        "List the skills visible to the caller in a workspace: their own personal skills, plus every " +
        'shared one (the same visibility rule the in-app Skills list enforces — this never widens it). ' +
        'Each entry carries when_to_use and allowed_tools so you can pick the right one, then call ' +
        'run_skill with its name or id.',
      inputSchema: { workspace: z.string().describe('Workspace name or id.') },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const skills = await listSkills(client, ws.id);
      return text(
        skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          when_to_use: s.when_to_use,
          visibility: s.visibility,
          allowed_tools: s.allowed_tools,
          editable: s.editable,
        })),
      );
    }),
  );

  /* =====================================================================
   * #442 (#406 area 9) — skill AUTHORING.
   *
   * `list_skills` and `run_skill` shipped with #41, so an agent could run a
   * skill and never write one — meaning the actor best placed to author a skill
   * (the one that just did the task successfully) was the only actor that could
   * not. That is the same write-but-never-read asymmetry areas 1–3 closed, run
   * backwards.
   *
   * Two rules, both enforced by the API rather than described here:
   *
   *   Authorship is DERIVED, never declared. `skills.source` is set from the
   *   request's auth (#390's precedent), so a skill written over MCP reads as
   *   `mcp` no matter what the caller sends.
   *
   *   An agent may write a PERSONAL skill and may not publish a SHARED one. A
   *   shared skill is instructions every other member's agent follows;
   *   publishing one is a decision about other people (ADR-0010).
   * ===================================================================== */

  /** The full read shape, including `instructions` — which `list_skills`
   * deliberately omits to keep a catalog listing small. */
  interface SkillFull extends SkillRef {
    workspace_id: string;
    owner_id: string;
    created_at: string;
    updated_at: string;
    last_run_at: string | null;
    last_run_status: 'ok' | 'error' | null;
  }

  /** One shape for a skill however you touched it, same reasoning as #343's
   * serializeRecord: a create/update echo that differs from a read forces a
   * re-read to find out whether anything was lost. */
  const serializeSkill = (s: Partial<SkillFull> & { id: string; name: string }) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    when_to_use: s.when_to_use,
    instructions: s.instructions,
    examples: s.examples,
    allowed_tools: s.allowed_tools,
    visibility: s.visibility,
    // Surfaced on every skill read: the only way a reader can tell an
    // agent-written instruction from a human-written one WITHOUT trusting the
    // instruction. There is no Skills page in the web app yet, so these tools
    // are where it is actually visible today.
    authored_by: s.source ?? 'human',
    source_template: s.source_template ?? null,
    editable: s.editable,
    last_run_at: s.last_run_at ?? null,
    last_run_status: s.last_run_status ?? null,
  });

  reg(
    'get_skill',
    {
      title: 'Get skill',
      description:
        "Read one skill in full, including its `instructions` — which list_skills omits to keep the catalog small. Read this before update_skill (a patch replaces a field WHOLE, so editing instructions means sending the full new text) and before following a skill you did not write.",
      inputSchema: { workspace: z.string(), skill: z.string().describe('Skill name or id (from list_skills).') },
    },
    handle<{ workspace: string; skill: string }>(async ({ workspace, skill }) => {
      const ws = await resolveWorkspace(client, workspace);
      const ref = await resolveSkill(client, ws.id, skill);
      const full = await unwrap<SkillFull>(
        client.GET('/api/v1/workspaces/{ws}/skills/{id}', { params: { path: { ws: ws.id, id: ref.id } } } as never),
      );
      return text(serializeSkill(full));
    }),
  );

  reg(
    'list_skill_templates',
    {
      title: 'List skill templates',
      description:
        'The starter scaffolds a skill can be authored from — each a complete, worked example of the six fields (name, description, when_to_use, instructions, examples, allowed_tools). Read one before create_skill: a skill written from a blank box tends to be a title and a vague sentence, and these show the level of detail that actually makes a skill re-runnable. Pass the one you started from as create_skill\'s `from_template`.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<{ data: Array<{ id: string; name: string; description: string; when_to_use: string; instructions: string }> }>(
        client.GET('/api/v1/workspaces/{ws}/skills/templates', { params: { path: { ws: ws.id } } } as never),
      );
      return text({ templates: res.data, use_with: 'create_skill(from_template: "<id>")' });
    }),
  );

  reg(
    'create_skill',
    {
      title: 'Create skill',
      description:
        'Save a reusable skill — a named instruction bundle you or another agent can run later with run_skill. Write one when you have just worked out how to do something in this workspace that will be asked for again; that is the moment the knowledge exists, and it is otherwise thrown away when the session ends. Call list_skill_templates first for a worked example of the level of detail that makes a skill re-runnable. ' +
        'TWO THINGS TO KNOW: the skill is recorded as authored by an agent (derived from your credential — you cannot set this), and it is created PERSONAL to the token owner. Sharing it with the workspace is a human decision made in-app, so `visibility` is not an argument here.',
      inputSchema: {
        workspace: z.string(),
        name: z.string().describe('Short, specific name — how a person will pick it out of a list. Max 100 chars.'),
        description: z.string().describe('One or two sentences on what it does. Max 500 chars.'),
        when_to_use: z
          .string()
          .describe(
            'The trigger, in the words someone would use when they need it — this is what a future agent matches against, so "when a lead lands and needs a first reply drafted" beats "for leads". Max 1000 chars.',
          ),
        instructions: z
          .string()
          .describe(
            'The actual procedure, as numbered steps. Write it for a reader with NO memory of this session: name the databases and fields explicitly, and say what NOT to do (invent a price, send anything). Max 20000 chars.',
          ),
        examples: z
          .array(z.object({ input: z.string(), output: z.string() }))
          .optional()
          .describe('Worked input→output pairs. One good example does more than a paragraph of clarification. Max 20.'),
        allowed_tools: z
          .array(z.string())
          .optional()
          .describe('Tool names this skill should stick to when run, e.g. ["query_records","create_record"]. Max 50.'),
        from_template: z.string().optional().describe('Template id from list_skill_templates, recorded as provenance.'),
      },
    },
    handle<{
      workspace: string;
      name: string;
      description: string;
      when_to_use: string;
      instructions: string;
      examples?: Array<{ input: string; output: string }>;
      allowed_tools?: string[];
      from_template?: string;
    }>(async ({ workspace, name, description, when_to_use, instructions, examples, allowed_tools, from_template }) => {
      const ws = await resolveWorkspace(client, workspace);
      const created = await unwrap<SkillFull>(
        client.POST('/api/v1/workspaces/{ws}/skills', {
          // `as never` because the skills routes declare `parameters: []` in the
          // spec (no @ApiParam for the class-level `:ws`), so the generated
          // types drop the path param. Same workaround listSkills already uses
          // in resolve.ts — the request is correct, the type is under-specified.
          params: { path: { ws: ws.id } } as never,
          body: {
            name,
            description,
            when_to_use,
            instructions,
            examples: examples ?? [],
            allowed_tools: allowed_tools ?? [],
            // Never sent as `shared`: the API refuses it for a non-human author
            // anyway, and a tool that offers an argument the server rejects is
            // a tool that teaches the wrong thing.
            visibility: 'personal',
            source_template: from_template,
          } as never,
        }),
      );
      return text({
        skill: serializeSkill(created),
        note: 'Personal to you and recorded as agent-authored. A person can read it in-app and promote it to shared.',
      });
    }),
  );

  reg(
    'update_skill',
    {
      title: 'Update skill',
      description:
        'Edit a skill you own — typically to sharpen `instructions` after running it and finding a step that was ambiguous. Each field you pass REPLACES that field whole, so read it with get_skill first and send the full new text rather than a fragment. Editing someone else\'s skill is refused, and this cannot publish a skill to the workspace (see create_skill).',
      inputSchema: {
        workspace: z.string(),
        skill: z.string().describe('Skill name or id (from list_skills).'),
        name: z.string().optional(),
        description: z.string().optional(),
        when_to_use: z.string().optional(),
        instructions: z.string().optional().describe('Replaces the whole procedure — get_skill first.'),
        examples: z.array(z.object({ input: z.string(), output: z.string() })).optional(),
        allowed_tools: z.array(z.string()).optional(),
      },
    },
    handle<{
      workspace: string;
      skill: string;
      name?: string;
      description?: string;
      when_to_use?: string;
      instructions?: string;
      examples?: Array<{ input: string; output: string }>;
      allowed_tools?: string[];
    }>(async ({ workspace, skill, ...patch }) => {
      const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(given).length === 0) throw new Error('Nothing to change — pass at least one field to update.');
      const ws = await resolveWorkspace(client, workspace);
      const ref = await resolveSkill(client, ws.id, skill);
      const updated = await unwrap<SkillFull>(
        client.PATCH('/api/v1/workspaces/{ws}/skills/{id}', {
          params: { path: { ws: ws.id, id: ref.id } } as never,
          body: given as never,
        }),
      );
      return text(serializeSkill(updated));
    }),
  );

  reg(
    'delete_skill',
    {
      title: 'Delete skill',
      description:
        'Delete a skill you own. Unlike a record there is no trash and no 30-day window — a skill is gone. If the goal is to stop it being suggested rather than to destroy it, edit its when_to_use instead. Deleting someone else\'s is refused even if you can see it.',
      inputSchema: {
        workspace: z.string(),
        skill: z.string().describe('Skill name or id (from list_skills).'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true. The guard exists because this is unrecoverable and a name can resolve by partial match.'),
      },
    },
    handle<{ workspace: string; skill: string; confirm?: boolean }>(async ({ workspace, skill, confirm }) => {
      const ws = await resolveWorkspace(client, workspace);
      const ref = await resolveSkill(client, ws.id, skill);
      // Resolve BEFORE demanding confirm, so the error can name what would be
      // destroyed — "confirm: true is required" on its own tells a caller
      // nothing about whether it picked the right skill.
      if (!confirm) {
        throw new Error(
          `Deleting "${ref.name}" is permanent — there is no trash for skills. Call again with confirm: true if that is what you mean.`,
        );
      }
      await unwrap(
        client.DELETE('/api/v1/workspaces/{ws}/skills/{id}', { params: { path: { ws: ws.id, id: ref.id } } } as never),
      );
      return text({ deleted: ref.id, name: ref.name });
    }),
  );

  reg(
    'export_skill',
    {
      title: 'Export skill',
      description:
        'Render a skill as portable instructions that mean the same thing pasted into a different tool: `markdown` (plain prose), `claude_skill` (a SKILL.md with name/description frontmatter, the on-disk Agent Skills convention), or `chatgpt` (custom-instructions shaped). Use this when someone asks for a skill they can take with them — every field of a skill is plain text by design, so nothing StoryOS-internal leaks into the output.',
      inputSchema: {
        workspace: z.string(),
        skill: z.string().describe('Skill name or id (from list_skills).'),
        format: z.enum(['markdown', 'claude_skill', 'chatgpt']).optional().describe('Default "markdown".'),
      },
    },
    handle<{ workspace: string; skill: string; format?: 'markdown' | 'claude_skill' | 'chatgpt' }>(
      async ({ workspace, skill, format }) => {
        const ws = await resolveWorkspace(client, workspace);
        const ref = await resolveSkill(client, ws.id, skill);
        const res = await unwrap<{ filename?: string; content?: string } & Record<string, unknown>>(
          client.GET('/api/v1/workspaces/{ws}/skills/{id}/export', {
            params: { path: { ws: ws.id, id: ref.id }, query: { format: format ?? 'markdown' } } as never,
          }),
        );
        return text({ skill: ref.name, format: format ?? 'markdown', ...res });
      },
    ),
  );

  reg(
    'run_skill',
    {
      title: 'Run skill',
      description:
        'Run a saved skill by name or id (from list_skills). StoryOS has no managed AI runtime yet ' +
        "(BYO-AI, never metered) — this resolves the skill's instructions/when_to_use/allowed_tools and " +
        'records the run (same bookkeeping as pressing "Run" in-app: last_run_at/last_run_status), but ' +
        'YOU are the model that actually carries out `instructions` against `inputs`. `inputs` is free-form ' +
        'and is only echoed back for you to act on — there is no server-side execution to send it to yet. ' +
        'If the skill declares allowed_tools, prefer those tools while following it.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        name: z.string().describe('Skill name or id (from list_skills).'),
        inputs: z
          .record(z.string(), z.any())
          .optional()
          .describe('Free-form inputs this run should apply the skill to — returned alongside the instructions for you to act on, not sent to the API.'),
      },
    },
    handle<{ workspace: string; name: string; inputs?: Record<string, unknown> }>(async ({ workspace, name, inputs }) => {
      const ws = await resolveWorkspace(client, workspace);
      const skill = await resolveSkill(client, ws.id, name);
      const run = await unwrap<{ run_class: string; steps: Array<{ tool: string; summary: string; detail?: string }>; ran_at: string }>(
        client.POST('/api/v1/workspaces/{ws}/skills/{id}/run', { params: { path: { ws: ws.id, id: skill.id } } } as never),
      );
      return text({
        skill: { id: skill.id, name: skill.name, when_to_use: skill.when_to_use, allowed_tools: skill.allowed_tools },
        instructions: skill.instructions,
        inputs: inputs ?? {},
        note: 'No model was invoked server-side — apply `instructions` to `inputs` yourself, preferring tools named in allowed_tools when the skill declares any.',
        run_log: run,
      });
    }),
  );

  /* =====================================================================
   * #447 (#406 area 14) — the agent engine: provisioning, running,
   * delegating, triggers, run history and quota.
   *
   * This is the product's own subject matter. An agent that could build
   * databases, views and automations but not set up another agent was missing
   * the layer everything else exists to support.
   *
   * THE HARD BOUNDARY, and it is not negotiable: approve and reject are NOT
   * here and must never be. ADR-0010's gate is human-only, and an agent able to
   * approve its own staged action does not weaken the gate — it removes it.
   * They are listed in EXCLUDED in coverage.ts with that reason, a test asserts
   * no such tool exists, and the natural way to build "staged runs" is to build
   * the whole lifecycle with the approval step sitting right there. Do not.
   *
   * get_staged_action exists precisely so the gate stays useful: an agent can
   * READ what is parked and tell a person what they are being asked to decide,
   * which is the opposite of deciding for them.
   * ===================================================================== */

  reg(
    'get_agents',
    {
      title: 'Get agents setup',
      description:
        "Whether this workspace has the Agentic OS provisioned, and a summary of its Agents / Runs / Agent Triggers databases. Returns `exists: false` when it has not been set up — call setup_agents then. Once it exists, the agents themselves are ordinary RECORDS in the Agents database, so list them with query_records and edit them with update_record.",
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/agents', { params: { path: { ws: ws.id } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'setup_agents',
    {
      title: 'Set up the agent engine',
      description:
        'Provision the Agentic OS space and its three databases (Agents, Runs, Agent Triggers). Idempotent — safe to call when it already exists, which is why get_agents and this can be used together without a check-then-act race. After this, create an agent with create_record against the Agents database.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/agents/ensure', { params: { path: { ws: ws.id } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'run_agent',
    {
      title: 'Run agent',
      description:
        'Run an agent by hand and get back its Run record, including the step log. Works with no model configured — the run class is stamped at dispatch and a runtime error lands as a Failed run rather than an error here, so read the returned run rather than assuming success from the absence of an exception. Use delegate_to_agent instead when the agent should work ON a particular record.',
      inputSchema: {
        workspace: z.string(),
        agent: z.string().describe("The agent record's uuid or public number (from the Agents database)."),
      },
    },
    handle<{ workspace: string; agent: string }>(async ({ workspace, agent }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/agents/{agent}/run', {
          params: { path: { ws: ws.id, agent } } as never,
        }),
      );
      return text(res);
    }),
  );

  reg(
    'delegate_to_agent',
    {
      title: 'Delegate a record to an agent',
      description:
        'Hand one record to an agent: it runs with that record as its context and posts its outcome back ON the record as a comment, with a link to the full Run. This is the one to reach for when a person asks "get the agent to handle this" — the trail stays where the work is, so the next human to open the record sees what happened without knowing runs exist.',
      inputSchema: {
        workspace: z.string(),
        agent: z.string().describe("The agent record's uuid or public number."),
        database: z.string().describe('Database holding the record to delegate.'),
        record: z.string().describe('Record uuid or public number.'),
      },
    },
    handle<{ workspace: string; agent: string; database: string; record: string }>(
      async ({ workspace, agent, database, record }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const rec = await resolveRecordId(ws.id, db.id, record);
        const res = await unwrap<unknown>(
          client.POST('/api/v1/workspaces/{ws}/agents/{agent}/delegate', {
            params: { path: { ws: ws.id, agent } } as never,
            body: { record_id: rec } as never,
          }),
        );
        return text(res);
      },
    ),
  );

  reg(
    'create_agent_trigger',
    {
      title: 'Create agent trigger',
      description:
        'Fire an agent whenever a record reaches a given state — e.g. run the triage agent when a lead moves to "New". Set human_gate:true to make the agent STAGE its action for a person to approve rather than apply it; that is the ADR-0010 gate, and it is the right default for anything that writes to something a customer sees. Read the database with describe_database first: the state field must be a select/workflow and the option must be one of its own.',
      inputSchema: {
        workspace: z.string(),
        agent: z.string().describe("The agent record's uuid or public number."),
        database: z.string().describe('The database whose state changes should fire the agent.'),
        state_field: z.string().describe('The select/workflow field to watch (name, api_name, or id).'),
        state: z.string().describe('The option that fires it — the human label, e.g. "New".'),
        human_gate: z
          .boolean()
          .optional()
          .describe('true = the agent stages its action for a person to approve instead of applying it (ADR-0010).'),
        enabled: z.boolean().optional().describe('Default true.'),
      },
    },
    handle<{
      workspace: string;
      agent: string;
      database: string;
      state_field: string;
      state: string;
      human_gate?: boolean;
      enabled?: boolean;
    }>(async ({ workspace, agent, database, state_field, state, human_gate, enabled }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const fieldId = resolveFieldId(detail, state_field, ['select', 'workflow'], 'select/workflow');
      const field = detail.fields.find((f) => f.id === fieldId);
      // Resolve the LABEL to an option id here, like every other write in this
      // file — the API wants an id, and asking an agent for a uuid it can only
      // get by reading the schema is the friction describe_database exists to
      // remove.
      const option = field?.options?.find(
        (o) => o.id === state || o.label.toLowerCase() === state.trim().toLowerCase(),
      );
      if (!option) {
        throw new Error(
          `No option "${state}" on ${field?.apiName ?? state_field}. Available: ${(field?.options ?? []).map((o) => o.label).join(', ') || '(none)'}.`,
        );
      }
      const res = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/agents/triggers', {
          params: { path: { ws: ws.id } } as never,
          body: {
            agent,
            database_id: db.id,
            state_field_id: fieldId,
            state_option_id: option.id,
            ...(human_gate === undefined ? {} : { human_gate }),
            ...(enabled === undefined ? {} : { enabled }),
          } as never,
        }),
      );
      return text(res);
    }),
  );

  reg(
    'get_staged_action',
    {
      title: 'Get a run’s staged action',
      description:
        "What a parked run is waiting to do, plus its step log — or null if it is not waiting. READ-ONLY, and deliberately: approving or rejecting is human-only (ADR-0010), and no tool here can do it. This exists so an agent can tell a person exactly what they are being asked to decide, which is the opposite of deciding for them. Point them at the Inbox to approve.",
      inputSchema: { workspace: z.string(), run: z.string().describe('Run id (from get_run / get_runs).') },
    },
    handle<{ workspace: string; run: string }>(async ({ workspace, run }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/agents/runs/{run}/staged', {
          params: { path: { ws: ws.id, run } } as never,
        }),
      );
      return text({
        run,
        staged: res,
        approve_with: 'A person, in the Inbox. Approval is human-only by design (ADR-0010) and is not available over MCP.',
      });
    }),
  );

  reg(
    'get_run',
    {
      title: 'Get run',
      description:
        'One run in full: what triggered it, each action with its attempts and artifacts, and its approval linkage. get_runs lists them; this is the one to read when something did not do what was expected, because the per-action attempt log is where the reason lives.',
      inputSchema: { workspace: z.string(), run: z.string().describe('Run id (from get_runs).') },
    },
    handle<{ workspace: string; run: string }>(async ({ workspace, run }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/runs/{id}', { params: { path: { ws: ws.id, id: run } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'get_run_quota',
    {
      title: 'Get run quota',
      description:
        "This month's automation-run usage against the plan allowance, with a projection of where the pace lands. Worth checking before building something that fires on every record change — a rule that looks harmless can be the one that exhausts the month.",
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/runs/quota', { params: { path: { ws: ws.id } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'rerun_action',
    {
      title: 'Re-run a failed action',
      description:
        "Retry ONE failed action from a run, with its original frozen inputs — so it repeats what it was actually asked to do, not what the record says now. Use it after fixing the cause (a bad credential, a missing field). Get the action's index from get_run. It re-runs a single action, never the whole run.",
      inputSchema: {
        workspace: z.string(),
        run: z.string().describe('Run id (from get_runs).'),
        action_index: z.number().int().min(0).describe("The failed action's index, from get_run."),
      },
    },
    handle<{ workspace: string; run: string; action_index: number }>(async ({ workspace, run, action_index }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/runs/{id}/actions/{index}/rerun', {
          params: { path: { ws: ws.id, id: run, index: String(action_index) } } as never,
        }),
      );
      return text(res);
    }),
  );

  /* =====================================================================
   * #439 (#406 area 6) — the inbox.
   *
   * An automation action can NOTIFY a person. Nothing could read the inbox. So
   * an agent could add to someone's pile and never tell them what was in it —
   * the same write-but-never-read asymmetry areas 1–3 closed, and the reason
   * this area was High while most of the rest were not.
   *
   * A PRIVACY BOUNDARY, not an ergonomics detail: an inbox is per-identity.
   * These read and write the notifications of whoever the TOKEN belongs to, and
   * there is no argument for choosing a person — the API has no such parameter
   * and this surface must not invent one. Said plainly in every description, so
   * an agent does not waste a turn trying to route around it.
   * ===================================================================== */

  /** The notification types the API filters on, listed so an agent can narrow
   * without guessing a string the server will reject. */
  const NOTIFICATION_TYPES = [
    'assigned',
    'mentioned',
    'commented',
    'state_changed',
    'approval_requested',
    'action_approval_requested',
  ] as const;

  /* =====================================================================
   * #440 (#406 area 7) — the surfaces a person actually opens.
   *
   * get_started maps a workspace STRUCTURALLY: spaces, databases, fields. That
   * says what EXISTS and nothing about what MATTERS. These answer the second
   * question, which is the cheaper and usually more useful one at the start of
   * a session.
   *
   * ONE tool with a `kind`, not three — the decision #440 asked for. They are
   * three lenses on one question ("what is this person working on"), the same
   * shape get_history took for "what happened to this record", and a catalog is
   * context every session pays for whether or not it calls anything.
   *
   * Per-identity, like the inbox (#439): these read the CALLER's surfaces and
   * there is no argument for choosing a person.
   * ===================================================================== */

  /* =====================================================================
   * #437 (#406 area 4) — view management beyond create/update/delete.
   *
   * #332 closed reading a view's config and querying through it. What was left
   * is everything about a view AS AN OBJECT: duplicating one, deciding which
   * one people land on, the space-level dashboards that belong to no database,
   * and the per-viewer personal filter.
   * ===================================================================== */

  reg(
    'duplicate_view',
    {
      title: 'Duplicate view',
      description:
        'Copy a view, with its filters, sorts, grouping and column layout. The fastest way to make a variant of something that already works — build the board once, duplicate it, then change the one thing that differs. Cheaper and safer than rebuilding a config by hand, which is where a filter gets subtly mistyped.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        view: z.string().describe('View name or id (from describe_database).'),
        name: z.string().optional().describe('Name for the copy. Defaults to the API\'s own "… copy".'),
      },
    },
    handle<{ workspace: string; database: string; view: string; name?: string }>(
      async ({ workspace, database, view, name }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const v = resolveView(detail, view);
        const created = await unwrap<{ id: string; name: string }>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/views/{view}/duplicate', {
            params: { path: { ws: ws.id, db: db.id, view: v.id } } as never,
            body: (name ? { name } : {}) as never,
          }),
        );
        return text({ ...created, url: viewUrl(ws.id, db.id, created.id) });
      },
    ),
  );

  reg(
    'set_default_view',
    {
      title: 'Set the default view',
      description:
        'Choose which view people land on when they open this database. Worth setting deliberately after building several: an agent that creates the right board and leaves the wrong view in front of everyone has done the work and hidden it. This changes what EVERY member sees, unlike a personal filter.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        view: z.string().describe('View name or id (from describe_database).'),
      },
    },
    handle<{ workspace: string; database: string; view: string }>(async ({ workspace, database, view }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const v = resolveView(detail, view);
      await unwrap(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/views/{view}/default', {
          params: { path: { ws: ws.id, db: db.id, view: v.id } } as never,
        }),
      );
      return text({ default_view: v.name, id: v.id, applies_to: 'everyone in this workspace' });
    }),
  );

  reg(
    'get_personal_filter',
    {
      title: 'Get my personal filter',
      description:
        "The extra filter the CALLING identity has layered on a view, on top of what everyone else sees, or null if none. Worth checking when a person says a view looks wrong: a personal filter is invisible to teammates by design, so \"my board is empty and yours isn't\" usually means this.",
      inputSchema: { workspace: z.string(), database: z.string(), view: z.string() },
    },
    handle<{ workspace: string; database: string; view: string }>(async ({ workspace, database, view }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const v = resolveView(detail, view);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/views/{view}/personal-filter', {
          params: { path: { ws: ws.id, db: db.id, view: v.id } } as never,
        }),
      );
      return text({ view: v.name, personal_filter: res, visible_to: 'you only' });
    }),
  );

  reg(
    'set_personal_filter',
    {
      title: 'Set my personal filter',
      description:
        'Narrow a view for YOURSELF only, leaving what teammates see untouched — "the team board, but just my rows". Pass clear:true to remove it. ' +
        'It writes for the identity this token belongs to and cannot filter anyone else\'s screen; to change the view for everyone, use update_view instead. Filter syntax is identical to query_records.',
      inputSchema: {
        workspace: z.string(),
        database: z.string(),
        view: z.string(),
        filter: z.record(z.string(), z.unknown()).optional().describe('A query_records-style filter. Omit with clear:true.'),
        clear: z.boolean().optional().describe('Remove the personal filter entirely.'),
      },
    },
    handle<{ workspace: string; database: string; view: string; filter?: Record<string, unknown>; clear?: boolean }>(
      async ({ workspace, database, view, filter, clear }) => {
        if (!clear && !filter) throw new Error('Pass a `filter`, or clear: true to remove the personal filter.');
        if (clear && filter) throw new Error('Pass either `filter` or clear: true, not both.');
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const v = resolveView(detail, view);
        const path = { ws: ws.id, db: db.id, view: v.id };
        if (clear) {
          await unwrap(
            client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/views/{view}/personal-filter', {
              params: { path } as never,
            }),
          );
          return text({ view: v.name, personal_filter: null });
        }
        // Same label→id mapping every other filter goes through, so a personal
        // filter takes "High" rather than an option uuid like query_records does.
        const mapped = mapFilterValues(detail, filter);
        await unwrap(
          client.PUT('/api/v1/workspaces/{ws}/databases/{db}/views/{view}/personal-filter', {
            params: { path } as never,
            body: { filter: mapped } as never,
          }),
        );
        return text({ view: v.name, personal_filter: mapped, visible_to: 'you only' });
      },
    ),
  );

  reg(
    'list_space_views',
    {
      title: 'List space views',
      description:
        'Views that belong to a SPACE rather than a database — dashboards that pull from several databases at once, and the ones that appear in the sidebar tree. describe_database only ever shows a database\'s own views, so these are invisible from there.',
      inputSchema: { workspace: z.string(), space: z.string() },
    },
    handle<{ workspace: string; space: string }>(async ({ workspace, space }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/spaces/{space}/views', {
          params: { path: { ws: ws.id, space: spaceId } } as never,
        }),
      );
      return text(res);
    }),
  );

  reg(
    'create_space_view',
    {
      title: 'Create a space view',
      description:
        'Create a space-level DASHBOARD — the only view type that lives on a space rather than a database, because it is the only one that reads from several. Use this for a "how is everything going" page; use create_view for anything scoped to one database.',
      inputSchema: {
        workspace: z.string(),
        space: z.string(),
        name: z.string(),
      },
    },
    handle<{ workspace: string; space: string; name: string }>(async ({ workspace, space, name }) => {
      const ws = await resolveWorkspace(client, workspace);
      const spaceId = await resolveSpaceId(ws.id, space);
      const created = await unwrap<{ id: string; name: string }>(
        client.POST('/api/v1/workspaces/{ws}/spaces/{space}/views', {
          params: { path: { ws: ws.id, space: spaceId } } as never,
          body: { name, type: 'dashboard' } as never,
        }),
      );
      return text(created);
    }),
  );

  reg(
    'get_view',
    {
      title: 'Get view',
      description:
        'One view by id, whether it belongs to a database or a space. describe_database covers a database\'s own views; reach for this when you hold a view id from a shared link or list_space_views and do not know which it is.',
      inputSchema: { workspace: z.string(), view: z.string().describe('View id.') },
    },
    handle<{ workspace: string; view: string }>(async ({ workspace, view }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/views/{view}', { params: { path: { ws: ws.id, view } } as never }),
      );
      return text(res);
    }),
  );

  reg(
    'update_space_view',
    {
      title: 'Update or move a space view',
      description:
        'Rename a space-level view, change its config, or MOVE a database dashboard into a space so it stops being scoped to one database. Pass `space` to move it. For a database view\'s filters and layout, use update_view.',
      inputSchema: {
        workspace: z.string(),
        view: z.string().describe('View id (from list_space_views or get_view).'),
        name: z.string().optional(),
        space: z.string().optional().describe('Move the view into this space (name, slug, or id).'),
      },
    },
    handle<{ workspace: string; view: string; name?: string; space?: string }>(
      async ({ workspace, view, name, space }) => {
        if (!name && !space) throw new Error('Nothing to change — pass `name` and/or `space`.');
        const ws = await resolveWorkspace(client, workspace);
        if (space) {
          const spaceId = await resolveSpaceId(ws.id, space);
          await unwrap(
            client.POST('/api/v1/workspaces/{ws}/views/{view}/move-to-space', {
              params: { path: { ws: ws.id, view } } as never,
              body: { space_id: spaceId } as never,
            }),
          );
        }
        if (name) {
          await unwrap(
            client.PATCH('/api/v1/workspaces/{ws}/views/{view}', {
              params: { path: { ws: ws.id, view } } as never,
              body: { name } as never,
            }),
          );
        }
        return text({ view, ...(name ? { name } : {}), ...(space ? { moved_to_space: space } : {}) });
      },
    ),
  );

  reg(
    'delete_space_view',
    {
      title: 'Delete a space view',
      description:
        'Delete a space-level view. Deletes the VIEW, never the records it showed — a dashboard is a lens, and removing it removes nothing underneath. Use delete_view for a database\'s own views.',
      inputSchema: { workspace: z.string(), view: z.string().describe('View id.') },
    },
    handle<{ workspace: string; view: string }>(async ({ workspace, view }) => {
      const ws = await resolveWorkspace(client, workspace);
      await unwrap(
        client.DELETE('/api/v1/workspaces/{ws}/views/{view}', { params: { path: { ws: ws.id, view } } as never }),
      );
      return text({ deleted: view, note: 'The view is gone; the records it showed are untouched.' });
    }),
  );

  /* =====================================================================
   * #441 (#406 area 8) — membership and access, READ ONLY.
   *
   * #406 said this area must have its read/write line drawn before anything was
   * built, and it does: the full reasoning is on the ticket. The short version
   * is in coverage.ts next to the EXCLUDED rule for the write half — a token's
   * SCOPE is what it may do and the GRANT SET is what it may do it to, so an
   * agent that edits the second can widen its own blast radius.
   *
   * What ships is the half that closes a real, daily gap: an agent had no way
   * to know who is in a workspace, so filling a `user` field was guesswork.
   * ===================================================================== */

  reg(
    'list_members',
    {
      title: 'List members',
      description:
        "Who is in this workspace and what role they hold — the list to check BEFORE writing a `user` field, because an address that is not a member is rejected and there was previously no way to find that out except by failing. Returns name, role and user id; the id is what a user field wants. " +
        'Read-only: this cannot invite, remove, or change anyone\'s access. Those are human decisions and have no tool at any scope.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<
        Array<{ id: string; role: string; user_id: string; user: { id: string; name: string; email: string | null; image: string | null } }>
      >(client.GET('/api/v1/workspaces/{ws}/members', { params: { path: { ws: ws.id } } as never }));
      return text({
        members: res.map((m) => ({
          /*
           * #441 — EMAIL IS DELIBERATELY OMITTED.
           *
           * The endpoint returns it. A read-scoped token is the weakest
           * credential the product issues, and the member list is the
           * workspace's contact sheet — so exposing it here would make a
           * read-only token a staff-directory harvester.
           *
           * Nothing legitimate needs it: filling a `user` field wants the ID,
           * and telling a person who someone is wants the NAME. If a later
           * ticket genuinely needs the address it can argue for it on its own
           * merits rather than inheriting it by default.
           */
          user_id: m.user.id,
          name: m.user.name,
          role: m.role,
          avatar: m.user.image,
        })),
        note: 'Use `user_id` when writing a user field. Changing membership or access is not available over MCP.',
      });
    }),
  );

  reg(
    'list_grants',
    {
      title: 'List access grants',
      description:
        'Who can reach which spaces and databases, beyond their workspace role. Read this when a person reports that a database is missing for them and present for you — a grant, or its absence, is usually the answer. Read-only: granting and revoking are human decisions.',
      inputSchema: {
        workspace: z.string(),
        user: z.string().optional().describe('Narrow to one user id (from list_members).'),
      },
    },
    handle<{ workspace: string; user?: string }>(async ({ workspace, user }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/grants', {
          params: { path: { ws: ws.id }, query: user ? { user_id: user } : {} } as never,
        }),
      );
      return text({ grants: res, note: 'Read-only — grants are changed in-app.' });
    }),
  );

  reg(
    'list_invites',
    {
      title: 'List pending invites',
      description:
        'Invitations sent but not yet accepted. Worth checking before telling someone a colleague "is not in the workspace" — they may simply not have clicked the link yet, which is a different problem with a different fix. Read-only: inviting and revoking are human decisions.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/invites', { params: { path: { ws: ws.id } } as never }),
      );
      return text({ pending_invites: res, note: 'Read-only — inviting is not available over MCP.' });
    }),
  );

  reg(
    'get_my_work',
    {
      title: 'What I am working on',
      description:
        'The three surfaces a person actually opens, for the identity this token belongs to. kind:"assigned" (default) = records assigned to them; kind:"created" = records they made; kind:"recent" = what they touched most recently; kind:"favorites" = what they starred. ' +
        'Worth calling at the START of a session: list_databases tells you what exists, this tells you what matters, and the two answer different questions. Reads YOUR surfaces only — there is no argument for another person.',
      inputSchema: {
        workspace: z.string(),
        kind: z.enum(['assigned', 'created', 'recent', 'favorites']).optional().describe('Default "assigned".'),
      },
    },
    handle<{ workspace: string; kind?: 'assigned' | 'created' | 'recent' | 'favorites' }>(
      async ({ workspace, kind }) => {
        const ws = await resolveWorkspace(client, workspace);
        const which = kind ?? 'assigned';
        if (which === 'favorites') {
          const res = await unwrap<unknown>(
            client.GET('/api/v1/workspaces/{ws}/favorites', { params: { path: { ws: ws.id } } as never }),
          );
          return text({ kind: which, favorites: res });
        }
        if (which === 'recent') {
          const res = await unwrap<unknown>(
            client.GET('/api/v1/workspaces/{ws}/recent', { params: { path: { ws: ws.id } } as never }),
          );
          return text({ kind: which, ...(res as Record<string, unknown>) });
        }
        const res = await unwrap<unknown>(
          client.GET('/api/v1/workspaces/{ws}/my-work', {
            params: { path: { ws: ws.id }, query: { tab: which } } as never,
          }),
        );
        return text({ kind: which, ...(res as Record<string, unknown>) });
      },
    ),
  );

  reg(
    'set_favorite',
    {
      title: 'Star or unstar',
      description:
        'Star a record or database for the calling identity, or remove a star. Starring is how a person finds something again, so this is worth doing after you build something they asked for — an unstarred new database is one they have to go looking for. Stars are per-person: this cannot star anything for a teammate.',
      inputSchema: {
        workspace: z.string(),
        target_type: z.enum(['record', 'database']),
        target: z.string().describe('Database name/slug/id, or a record uuid.'),
        database: z.string().optional().describe('Required when target_type is "record" and `target` is a public number.'),
        starred: z.boolean().optional().describe('true (default) to star, false to unstar.'),
      },
    },
    handle<{ workspace: string; target_type: 'record' | 'database'; target: string; database?: string; starred?: boolean }>(
      async ({ workspace, target_type, target, database, starred }) => {
        const ws = await resolveWorkspace(client, workspace);
        let id = target;
        if (target_type === 'database') {
          id = (await resolveDatabase(client, ws.id, target)).id;
        } else if (database) {
          const db = await resolveDatabase(client, ws.id, database);
          id = await resolveRecordId(ws.id, db.id, target);
        }
        const on = starred ?? true;
        if (on) {
          await unwrap(
            client.POST('/api/v1/workspaces/{ws}/favorites', {
              params: { path: { ws: ws.id } } as never,
              body: { target_type, target_id: id } as never,
            }),
          );
        } else {
          await unwrap(
            client.DELETE('/api/v1/workspaces/{ws}/favorites/{type}/{id}', {
              params: { path: { ws: ws.id, type: target_type, id } } as never,
            }),
          );
        }
        return text({ target_type, target_id: id, starred: on });
      },
    ),
  );

  reg(
    'list_notifications',
    {
      title: 'List my notifications',
      description:
        'What is waiting for the identity this token belongs to — assignments, mentions, comments, state changes and approval requests, newest first. This is the "what should I look at" question, and it is the one an agent could not answer before: notify existed, reading did not. ' +
        'It reads YOUR inbox and cannot read anyone else\'s; there is no argument for choosing a person and the API has none. To make someone else aware of something, mention them with add_comment.',
      inputSchema: {
        workspace: z.string(),
        unread_only: z.boolean().optional().describe('Only what has not been read yet.'),
        type: z.enum(NOTIFICATION_TYPES).optional().describe('Narrow to one kind.'),
        archived: z.boolean().optional().describe('Show the archived pile instead of the inbox.'),
        cursor: z.string().optional().describe('next_cursor from a previous call.'),
      },
    },
    handle<{ workspace: string; unread_only?: boolean; type?: string; archived?: boolean; cursor?: string }>(
      async ({ workspace, unread_only, type, archived, cursor }) => {
        const ws = await resolveWorkspace(client, workspace);
        const res = await unwrap<{
          data: Array<{
            id: string;
            type: string;
            snippet: string | null;
            read_at: string | null;
            created_at: string;
            record: { id: string; title: string; database_id: string; deleted: boolean } | null;
            actor: { id: string; name: string } | null;
          }>;
          next_cursor: string | null;
        }>(
          client.GET('/api/v1/workspaces/{ws}/notifications', {
            params: {
              path: { ws: ws.id },
              query: {
                ...(unread_only ? { unread_only: 'true' } : {}),
                ...(type ? { type } : {}),
                ...(archived ? { archived: 'true' } : {}),
                ...(cursor ? { cursor } : {}),
              },
            } as never,
          }),
        );
        return text({
          notifications: res.data.map((n) => ({
            id: n.id,
            type: n.type,
            what: n.snippet,
            from: n.actor?.name ?? null,
            unread: n.read_at === null,
            created_at: n.created_at,
            // The record link is the actionable part — a notification without a
            // way to reach what it is about is just a sentence.
            record: n.record
              ? { id: n.record.id, title: n.record.title, deleted: n.record.deleted, url: recordUrl(ws.id, n.record.database_id, n.record) }
              : null,
          })),
          next_cursor: res.next_cursor,
        });
      },
    ),
  );

  reg(
    'get_unread_count',
    {
      title: 'Count my unread notifications',
      description:
        'How many unread notifications the calling identity has — one number, no pagination. Cheaper than list_notifications when the question is only "is there anything waiting", e.g. at the start of a session.',
      inputSchema: { workspace: z.string() },
    },
    handle<{ workspace: string }>(async ({ workspace }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/notifications/unread-count', { params: { path: { ws: ws.id } } as never }),
      );
      return text(typeof res === 'number' ? { unread: res } : (res as Record<string, unknown>));
    }),
  );

  reg(
    'mark_notifications',
    {
      title: 'Mark my notifications',
      description:
        'Mark notifications read, or archive them, for the calling identity only. Pass `all: true` with action "read" to clear the whole inbox at once. ' +
        'Think before archiving on someone\'s behalf: it is their inbox, and a notification archived by an agent is one they never saw. Reading and reporting is usually the useful act; clearing is theirs to ask for.',
      inputSchema: {
        workspace: z.string(),
        action: z.enum(['read', 'archive', 'unarchive']).describe('What to do with them.'),
        notifications: z.array(z.string()).optional().describe('Notification ids from list_notifications.'),
        all: z.boolean().optional().describe('With action "read" only: mark everything read.'),
      },
    },
    handle<{ workspace: string; action: 'read' | 'archive' | 'unarchive'; notifications?: string[]; all?: boolean }>(
      async ({ workspace, action, notifications, all }) => {
        if (all && action !== 'read') throw new Error('`all` is only supported with action "read" — the API has no archive-all.');
        if (!all && !notifications?.length) throw new Error('Pass `notifications` ids, or all: true with action "read".');
        const ws = await resolveWorkspace(client, workspace);

        if (all) {
          await unwrap(
            client.POST('/api/v1/workspaces/{ws}/notifications/read-all', { params: { path: { ws: ws.id } } as never }),
          );
          return text({ marked: 'all', action: 'read' });
        }
        /*
         * One call per id: the API exposes no batch for these, and looping is
         * honest about that rather than pretending a bulk endpoint exists.
         *
         * The three paths are written out LITERALLY rather than interpolated.
         * coverage.test.ts derives what the MCP reaches by grepping the actual
         * client call sites out of this source, so an interpolated path would
         * read as three unreachable endpoints and the parity check would be
         * wrong in the direction that matters — claiming a gap that is closed.
         *
         * (That grep reads comments too. Writing a fake call site in prose here
         * made the test fail, which is the check doing exactly its job.)
         */
        for (const id of notifications!) {
          const params = { path: { ws: ws.id, id } } as never;
          await unwrap(
            action === 'read'
              ? client.POST('/api/v1/workspaces/{ws}/notifications/{id}/read', { params })
              : action === 'archive'
                ? client.POST('/api/v1/workspaces/{ws}/notifications/{id}/archive', { params })
                : client.POST('/api/v1/workspaces/{ws}/notifications/{id}/unarchive', { params }),
          );
        }
        return text({ marked: notifications!.length, action });
      },
    ),
  );

  reg(
    'list_approvals',
    {
      title: 'List approvals',
      description:
        'MN-255: list this workspace\'s require_approval gate items (pending/approved/rejected/expired) — the preview text, status and approver of each. ' +
        'Read-only: approving or rejecting happens in the app Inbox, not via MCP, so a human always makes that call.',
      inputSchema: {
        workspace: z.string(),
        status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional().describe('Filter by status; omit for all.'),
      },
    },
    handle<{ workspace: string; status?: 'pending' | 'approved' | 'rejected' | 'expired' }>(
      async ({ workspace, status }) => {
        const ws = await resolveWorkspace(client, workspace);
        const res = await unwrap<unknown>(
          client.GET('/api/v1/workspaces/{ws}/approvals', {
            params: { path: { ws: ws.id }, query: status ? { status } : undefined },
          } as never),
        );
        return text(res);
      },
    ),
  );

  reg(
    'get_runs',
    {
      title: 'Get runs',
      description:
        "MN-264: this is how you answer \"why didn't my automation fire / post go out?\" — every automation rule run in the " +
        'workspace, newest first, with status (ok/error/skipped/skipped_quota/running), the triggering record, and a per-action ' +
        "summary (kind + status of each external action attempted). NOTE: this covers RULE runs only — a workspace's source syncs " +
        "(#239) aren't unioned in yet, so this can't yet answer questions about a source's sync history — see list_sources for " +
        "that. Read-only: re-running a failed action happens in the app Runs page, not via MCP.",
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        status: z
          .enum(['ok', 'error', 'skipped', 'skipped_quota', 'running'])
          .optional()
          .describe('Filter by status; omit for all.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).'),
      },
    },
    handle<{ workspace: string; status?: string; limit?: number }>(async ({ workspace, status, limit }) => {
      const ws = await resolveWorkspace(client, workspace);
      const res = await unwrap<unknown>(
        client.GET('/api/v1/workspaces/{ws}/runs', {
          params: { path: { ws: ws.id }, query: { status, limit } },
        } as never),
      );
      return text(res);
    }),
  );

  reg(
    'list_sources',
    {
      title: 'List sources',
      description:
        'The scheduled syncs feeding this database from an external provider — provider, schedule, status, field_mapping, connection_id and last_sync_at for each. ' +
        'Use this to diagnose data freshness ("is this database still syncing?") before trusting its records as current. ' +
        'Configuring a source IS reachable over MCP (#438): list_source_providers → discover_source_fields → create_source, then sync_source and list_source_runs. ' +
        'This is also the only place an existing connection_id is readable — see create_source.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
      },
    },
    handle<{ workspace: string; database: string }>(async ({ workspace, database }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const res = await unwrap<{ data?: Array<Record<string, unknown>> }>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/sources', {
          params: { path: { ws: ws.id, db: db.id } },
        } as never),
      );
      return text(res.data ?? []);
    }),
  );

  // ---- #438: the rest of the sources area — discover → propose → apply. ----
  //
  // #239 exposed `list_sources` only, reasoning that "the field-mapping dialog
  // is not something an agent should improvise". Correct about a BLIND mapping,
  // and it stops applying once the remote schema is readable: `discover_source_
  // fields` returns the provider's real keys AND a proposed mapping against
  // this database's fields, and `create_source` applies a mapping it is handed.
  //
  // What deliberately did NOT change: credentials. `create_source` takes a
  // `connection_id`, never a secret, so nothing here puts auth material into a
  // tool argument or a transcript — the connections rule (coverage.ts) stays
  // untouched. The cost is that an agent has no way to LOOK UP a connection id;
  // that is #491, and `create_source` says so rather than leaving it to be
  // discovered by failure.

  interface SourceRow {
    id: string;
    name: string;
    connection_id: string;
    provider_source: string;
    field_mapping?: Record<string, string>;
  }

  /** Name-or-id resolution for a source (MN-076 convention), scoped to one database. */
  async function resolveSource(wsId: string, dbId: string, ref: string): Promise<SourceRow> {
    const res = await unwrap<{ data?: SourceRow[] }>(
      client.GET('/api/v1/workspaces/{ws}/databases/{db}/sources', {
        params: { path: { ws: wsId, db: dbId } },
      } as never),
    );
    const list = res.data ?? [];
    const byId = list.find((s) => s.id === ref);
    if (byId) return byId;
    const lower = ref.trim().toLowerCase();
    const exact = list.filter((s) => s.name.toLowerCase() === lower);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) {
      throw new Error(`"${ref}" matches ${exact.length} sources in this database. Pass the source id from list_sources.`);
    }
    throw new Error(
      `No source matches "${ref}" in this database. Available: ${list.map((s) => s.name).join(', ') || '(none)'}.`,
    );
  }

  /** A field id from a name, api_name or id — any type. The mapping targets are
   * ordinary fields, so unlike resolveFieldId this does not narrow by type. */
  function resolveAnyFieldId(detail: DatabaseDetail, ref: string): string {
    const lower = ref.trim().toLowerCase();
    const f = detail.fields.find(
      (x) => x.id === ref || x.apiName.toLowerCase() === lower || x.displayName.toLowerCase() === lower,
    );
    if (!f) {
      throw new Error(
        `No field matches "${ref}" in this database. Available: ${detail.fields.map((x) => x.apiName).join(', ') || '(none)'}.`,
      );
    }
    return f.id;
  }

  /** Map a caller's `{ externalKey: fieldNameOrId }` onto the API's `{ externalKey: fieldId }`. */
  function resolveFieldMapping(detail: DatabaseDetail, mapping: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, ref] of Object.entries(mapping)) {
      if (typeof ref !== 'string') {
        throw new Error(`field_mapping["${key}"] must be a field name or id, got ${JSON.stringify(ref)}.`);
      }
      out[key] = resolveAnyFieldId(detail, ref);
    }
    return out;
  }

  /** Comparison key for matching a provider's external key to a field name. */
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  reg(
    'list_source_providers',
    {
      title: 'List source providers',
      description:
        'What this database can sync FROM: the provider catalog — each entry\'s `id` (the `provider_source` value create_source needs, e.g. "youtube.comments"), the `connection_provider` its connection must be, its `config_schema`, and `supports_discover`. ' +
        'Providers an operator has disabled on this server are omitted, so anything listed here can actually be created. ' +
        'Call this before create_source: provider ids and config keys come from here, never from memory.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id — the sync TARGET.'),
      },
    },
    handle<{ workspace: string; database: string }>(async ({ workspace, database }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const res = await unwrap<{ data?: unknown[] }>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/sources/providers', {
          params: { path: { ws: ws.id, db: db.id } },
        } as never),
      );
      return text(res.data ?? []);
    }),
  );

  reg(
    'list_youtube_channels',
    {
      title: 'List YouTube channels',
      description:
        'The YouTube channels a connected Google account owns, as `{ id, title }`. Needed only to fill the `channel_id` config key of the youtube.* source providers — a source created against the wrong channel syncs nothing and looks healthy while doing it. ' +
        'Reads through to YouTube using the stored connection; creates and changes nothing. Requires a "google" connection — any other provider is rejected.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        connection_id: z
          .string()
          .describe('The google connection\'s id. See create_source for where a connection_id comes from.'),
      },
    },
    handle<{ workspace: string; database: string; connection_id: string }>(
      async ({ workspace, database, connection_id }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const res = await unwrap<{ data?: unknown[] }>(
          client.GET('/api/v1/workspaces/{ws}/databases/{db}/sources/channels', {
            params: { path: { ws: ws.id, db: db.id }, query: { connection_id } },
          } as never),
        );
        return text(res.data ?? []);
      },
    ),
  );

  reg(
    'discover_source_fields',
    {
      title: 'Discover source fields',
      description:
        'Ask the provider what it would actually return, and propose how to map it onto this database. CREATES NOTHING, syncs nothing, writes nothing. ' +
        'Returns `keys` (the provider\'s real external keys), `proposed_field_mapping` (key → field, matched by name), `unmatched_keys` (no field looks right — add a field or map them by hand) and `suggested_external_key_field`. ' +
        'The proposal is a SUGGESTION from name matching, not a verified mapping: show it, let it be corrected, then pass the agreed mapping to create_source. This is the discover → propose → apply path — never hand create_source a mapping nothing has looked at. ' +
        'Only providers whose `supports_discover` is true (see list_source_providers) can answer; the rest return an error naming the provider.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id — the sync TARGET, whose fields the proposal maps onto.'),
        connection_id: z.string().describe('The connection to read through. See create_source for where a connection_id comes from.'),
        provider_source: z.string().describe('Provider id from list_source_providers, e.g. "youtube.comments".'),
        config: z
          .record(z.string(), z.any())
          .optional()
          .describe('Provider config (shape in list_source_providers\' config_schema). Partial is fine — discovery tolerates a half-filled config.'),
      },
    },
    handle<{
      workspace: string;
      database: string;
      connection_id: string;
      provider_source: string;
      config?: Record<string, unknown>;
    }>(async ({ workspace, database, connection_id, provider_source, config }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const [discovered, detail] = await Promise.all([
        unwrap<{ keys?: string[] }>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/sources/discover', {
            params: { path: { ws: ws.id, db: db.id } } as never,
            body: { connection_id, provider_source, config: config ?? {} } as never,
          }),
        ),
        getDetail(ws.id, db.id),
      ]);
      const keys = discovered.keys ?? [];
      const candidates = detail.fields.filter((f) => !f.isSystem);
      const proposed: Record<string, string> = {};
      const unmatched: string[] = [];
      const taken = new Set<string>();
      for (const key of keys) {
        const hit = candidates.find(
          (f) => !taken.has(f.id) && (norm(f.apiName) === norm(key) || norm(f.displayName) === norm(key)),
        );
        if (hit) {
          proposed[key] = hit.apiName;
          taken.add(hit.id);
        } else {
          unmatched.push(key);
        }
      }
      /*
       * The external key is what makes a re-sync UPDATE instead of duplicate, so
       * a wrong guess here is the expensive one. Only ever suggest a key that
       * actually looks like an identifier, and say plainly when nothing does —
       * an empty suggestion the caller must fill is better than a confident one
       * that silently doubles the database on the second sync.
       */
      const idKey = keys.find((k) => /(^|_)(id|key|guid|uuid)$/i.test(k)) ?? null;
      return text({
        provider_source,
        keys,
        proposed_field_mapping: proposed,
        unmatched_keys: unmatched,
        suggested_external_key_field: idKey ? (proposed[idKey] ?? null) : null,
        note:
          'Nothing was created. proposed_field_mapping is a NAME MATCH, not a verified mapping — review it, then pass the agreed version to create_source as field_mapping. ' +
          (unmatched.length
            ? `${unmatched.length} key(s) matched no field: ${unmatched.join(', ')}. Add fields with add_field, or leave them unmapped (unmapped keys are simply not stored).`
            : 'Every discovered key matched a field by name.') +
          ' external_key_field must be one of field_mapping\'s targets and must be the provider\'s STABLE id — get it wrong and every sync re-creates rather than updates.',
      });
    }),
  );

  reg(
    'create_source',
    {
      title: 'Create source',
      description:
        'Configure a scheduled sync from an external provider INTO this database, and start it running. ' +
        'CREDENTIALS NEVER PASS THROUGH THIS TOOL: connect the account once in the app (Settings → Connections) and reference it by `connection_id`. There is no MCP tool that lists connections yet (#491), so today a connection_id comes from list_sources on a database that already syncs, or from a human. ' +
        'Run list_source_providers then discover_source_fields first — `field_mapping` should be a mapping somebody has looked at, not a guess. ' +
        'field_mapping maps the provider\'s external keys to fields in THIS database, and takes field names or ids ("Comment text" or a uuid). Keys you leave out are simply not stored. ' +
        'external_key_field is the field holding the provider\'s stable id; it MUST be one of field_mapping\'s targets, and it is what makes the next sync update a record rather than duplicate it. ' +
        'Defaults to a daily sync when neither schedule nor recurrence is given. The source is created active — call sync_source to run it immediately instead of waiting for the schedule.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id — the sync TARGET.'),
        name: z.string().describe('A human label for this source, e.g. "Shopify orders".'),
        connection_id: z
          .string()
          .describe('Id of the stored connection to sync through. NOT a credential — see this tool\'s description for where it comes from.'),
        provider_source: z.string().describe('Provider id from list_source_providers, e.g. "youtube.comments".'),
        field_mapping: z
          .record(z.string(), z.string())
          .describe('{ "provider_external_key": "field name or id" }. Start from discover_source_fields\' proposed_field_mapping.'),
        external_key_field: z
          .string()
          .describe('Field (name or id) holding the provider\'s stable id. Must be one of field_mapping\'s target fields.'),
        config: z
          .record(z.string(), z.any())
          .optional()
          .describe('Provider config; shape is in list_source_providers\' config_schema.'),
        schedule: z
          .enum(['15m', 'hour', 'day'])
          .optional()
          .describe('Coarse cadence. Omit to get the default daily sync, or pass `recurrence` for an exact time.'),
        recurrence: z
          .record(z.string(), z.any())
          .optional()
          .describe('Exact cadence, and it wins over `schedule`: {kind:"hourly",minute} | {kind:"daily",hour,minute} | {kind:"weekly",weekday,hour,minute}.'),
      },
    },
    handle<{
      workspace: string;
      database: string;
      name: string;
      connection_id: string;
      provider_source: string;
      field_mapping: Record<string, string>;
      external_key_field: string;
      config?: Record<string, unknown>;
      schedule?: string;
      recurrence?: Record<string, unknown>;
    }>(async (a) => {
      const ws = await resolveWorkspace(client, a.workspace);
      const db = await resolveDatabase(client, ws.id, a.database);
      const detail = await getDetail(ws.id, db.id);
      const mapping = resolveFieldMapping(detail, a.field_mapping);
      const externalKeyFieldId = resolveAnyFieldId(detail, a.external_key_field);
      /*
       * The API enforces this too (400). Catching it here costs nothing and
       * answers with the field NAMES the caller used, rather than making them
       * match uuids by eye to find out which one they meant.
       */
      if (!Object.values(mapping).includes(externalKeyFieldId)) {
        throw new Error(
          `external_key_field "${a.external_key_field}" is not one of field_mapping's target fields (${Object.values(a.field_mapping).join(', ')}). ` +
            'The external key must be a field the provider actually writes to, or a re-sync cannot match an existing record.',
        );
      }
      const created = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/sources', {
          params: { path: { ws: ws.id, db: db.id } } as never,
          body: {
            name: a.name,
            connection_id: a.connection_id,
            provider_source: a.provider_source,
            config: a.config ?? {},
            field_mapping: mapping,
            external_key_field_id: externalKeyFieldId,
            ...(a.schedule ? { schedule: a.schedule } : {}),
            ...(a.recurrence ? { recurrence: a.recurrence } : {}),
          } as never,
        }),
      );
      return text(created);
    }),
  );

  reg(
    'update_source',
    {
      title: 'Update source',
      description:
        'Reconfigure an existing source — rename it, change its schedule, repoint its field mapping, or pause and resume it. A true patch: omitted arguments are left as they are. ' +
        'Pass status:"paused" to stop it syncing without deleting it (delete_source discards the configuration; pausing keeps it). ' +
        'field_mapping REPLACES the whole mapping rather than merging into it, so send the complete map — read the current one from list_sources first.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        source: z.string().describe('Source name or id (from list_sources).'),
        name: z.string().optional().describe('New human label.'),
        connection_id: z.string().optional().describe('Point the source at a different stored connection.'),
        config: z.record(z.string(), z.any()).optional().describe('Replacement provider config.'),
        field_mapping: z
          .record(z.string(), z.string())
          .describe('{ "provider_external_key": "field name or id" } — the COMPLETE mapping, which replaces the existing one.')
          .optional(),
        external_key_field: z.string().optional().describe('Field (name or id) holding the provider\'s stable id.'),
        schedule: z.enum(['15m', 'hour', 'day']).optional().describe('Coarse cadence.'),
        recurrence: z
          .record(z.string(), z.any())
          .optional()
          .describe('Exact cadence, wins over `schedule`: {kind:"hourly",minute} | {kind:"daily",hour,minute} | {kind:"weekly",weekday,hour,minute}.'),
        status: z
          .enum(['active', 'paused', 'error'])
          .optional()
          .describe('"paused" stops the schedule without discarding the source; "active" resumes it.'),
      },
    },
    handle<{
      workspace: string;
      database: string;
      source: string;
      name?: string;
      connection_id?: string;
      config?: Record<string, unknown>;
      field_mapping?: Record<string, string>;
      external_key_field?: string;
      schedule?: string;
      recurrence?: Record<string, unknown>;
      status?: string;
    }>(async (a) => {
      const ws = await resolveWorkspace(client, a.workspace);
      const db = await resolveDatabase(client, ws.id, a.database);
      const src = await resolveSource(ws.id, db.id, a.source);
      const body: Record<string, unknown> = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.connection_id !== undefined) body.connection_id = a.connection_id;
      if (a.config !== undefined) body.config = a.config;
      if (a.schedule !== undefined) body.schedule = a.schedule;
      if (a.recurrence !== undefined) body.recurrence = a.recurrence;
      if (a.status !== undefined) body.status = a.status;
      if (a.field_mapping !== undefined || a.external_key_field !== undefined) {
        const detail = await getDetail(ws.id, db.id);
        if (a.field_mapping !== undefined) body.field_mapping = resolveFieldMapping(detail, a.field_mapping);
        if (a.external_key_field !== undefined) {
          body.external_key_field_id = resolveAnyFieldId(detail, a.external_key_field);
        }
        /*
         * The API's create path enforces "external key must be one of the
         * mapping's targets"; on update the two arrive independently, so a
         * caller changing only one can strand the pair. Check against the
         * EFFECTIVE post-patch pair (new value, else the stored one).
         */
        const effectiveMapping = (body.field_mapping as Record<string, string>) ?? src.field_mapping ?? {};
        const effectiveKey = (body.external_key_field_id as string) ?? undefined;
        if (effectiveKey && Object.keys(effectiveMapping).length && !Object.values(effectiveMapping).includes(effectiveKey)) {
          throw new Error(
            'external_key_field is not one of field_mapping\'s target fields after this change. ' +
              'Send field_mapping and external_key_field together when either one moves, or the source loses its ability to match an existing record on re-sync.',
          );
        }
      }
      if (Object.keys(body).length === 0) {
        throw new Error('Nothing to update — pass at least one of name, connection_id, config, field_mapping, external_key_field, schedule, recurrence, status.');
      }
      const updated = await unwrap<unknown>(
        client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/sources/{id}', {
          params: { path: { ws: ws.id, db: db.id, id: src.id } } as never,
          body: body as never,
        }),
      );
      return text(updated);
    }),
  );

  reg(
    'delete_source',
    {
      title: 'Delete source',
      description:
        'Stop syncing and discard the source configuration — its field mapping, schedule and sync cursor. ' +
        'RECORDS ARE NOT DELETED: every record the source ever created stays in the database, it simply stops being updated. ' +
        'The configuration itself is NOT recoverable, so `confirm` must equal the source\'s name exactly. To stop a sync temporarily, use update_source with status:"paused" instead — that keeps the configuration.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        source: z.string().describe('Source name or id (from list_sources).'),
        confirm: z.string().describe('The source\'s exact name, as a guard against deleting the wrong one.'),
      },
    },
    handle<{ workspace: string; database: string; source: string; confirm: string }>(
      async ({ workspace, database, source, confirm }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const src = await resolveSource(ws.id, db.id, source);
        if (confirm !== src.name) {
          throw new Error(
            `confirm must equal the source's exact name to delete it. Got "${confirm}", expected "${src.name}". Nothing was deleted.`,
          );
        }
        await unwrap<unknown>(
          client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/sources/{id}', {
            params: { path: { ws: ws.id, db: db.id, id: src.id } } as never,
          }),
        );
        return text({
          deleted: { id: src.id, name: src.name },
          records: 'kept — deleting a source never deletes the records it created',
        });
      },
    ),
  );

  reg(
    'sync_source',
    {
      title: 'Sync source now',
      description:
        'Run one sync cycle immediately, ignoring the schedule. Returns that run\'s outcome — records fetched, created, updated, and the error if it failed. ' +
        'Use it to prove a newly created source actually works instead of waiting for its schedule, and to refresh data on demand. ' +
        'The run is recorded in the same log as a scheduled one, so list_source_runs shows it alongside the rest.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        source: z.string().describe('Source name or id (from list_sources).'),
      },
    },
    handle<{ workspace: string; database: string; source: string }>(async ({ workspace, database, source }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const src = await resolveSource(ws.id, db.id, source);
      const run = await unwrap<unknown>(
        client.POST('/api/v1/workspaces/{ws}/databases/{db}/sources/{id}/sync-now', {
          params: { path: { ws: ws.id, db: db.id, id: src.id } } as never,
        }),
      );
      return text(run);
    }),
  );

  reg(
    'list_source_runs',
    {
      title: 'List source runs',
      description:
        'The sync history for ONE source, newest first — status, when it ran, how many records it fetched/created/updated, and the error message when it failed. ' +
        'This is the answer to "the data looks stale" and "did my sync actually do anything": a source can sit at status active and be failing every cycle. ' +
        'Covers scheduled runs and sync_source runs alike.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        source: z.string().describe('Source name or id (from list_sources).'),
        limit: z.number().int().min(1).max(200).optional().describe('Max runs to return (default 50).'),
      },
    },
    handle<{ workspace: string; database: string; source: string; limit?: number }>(
      async ({ workspace, database, source, limit }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const src = await resolveSource(ws.id, db.id, source);
        const res = await unwrap<{ data?: unknown[] }>(
          client.GET('/api/v1/workspaces/{ws}/databases/{db}/sources/{id}/runs', {
            params: {
              path: { ws: ws.id, db: db.id, id: src.id },
              query: { limit: String(limit ?? 50) },
            },
          } as never),
        );
        return text(res.data ?? res);
      },
    ),
  );

  // ---- #334: automation-rule CRUD — build a complete workflow over MCP. ----
  //
  // Every tool here calls the SAME endpoints the in-app RuleEditor does, so the
  // in-app validation (AutomationActionsService.validate) is the ONE validator —
  // there is no parallel path. Human-readable trigger/action field references
  // resolve to ids client-side (against describe_database's schema); anything not
  // resolvable here (connections, agents, relation targets) is validated server-
  // side, which returns a structured 422 that handle() surfaces (never a 500).

  /**
   * Turn the model's human-friendly actions into the API's id-based shape.
   * OWN-database refs go through resolveActionFieldRefs; a create_record's target
   * database (and the values/link field scoped to IT) is resolved here since it
   * needs another describe_database round-trip.
   */
  async function resolveAutomationActions(
    actions: unknown,
    ownDetail: DatabaseDetail,
    wsId: string,
  ): Promise<unknown[]> {
    if (!Array.isArray(actions)) {
      throw new Error('`actions` must be an array of action objects (min 1, max 10).');
    }
    const out: unknown[] = [];
    for (const raw of actions) {
      const a = raw as Record<string, unknown>;
      // #297: `create_records` (#246) fell through to the generic branch, making it
      // the ONLY action whose target database had to be a raw uuid — an agent
      // couldn't say "Tasks". Both types resolve identically; `count` and the rest
      // pass through untouched.
      if (a?.type === 'create_record' || a?.type === 'create_records') {
        const ref = (a.database ?? a.database_id) as string | undefined;
        if (ref === undefined) throw new Error(`${String(a.type)} action needs a target "database".`);
        const targetDb = await resolveDatabase(client, wsId, ref);
        const targetDetail = await getDetail(wsId, targetDb.id);
        const rest = { ...a };
        delete rest.database;
        delete rest.link_via_relation_field;
        const resolved: Record<string, unknown> = { ...rest, database_id: targetDb.id };
        if (a.values && typeof a.values === 'object') {
          resolved.values = resolveValueMap(targetDetail as never, a.values as Record<string, unknown>);
        }
        const linkRef = (a.link_via_relation_field ?? a.link_via_relation_field_id) as string | undefined;
        if (linkRef !== undefined) {
          resolved.link_via_relation_field_id = resolveFieldId(targetDetail, linkRef, ['relation'], 'relation');
        }
        out.push(resolved);
      } else {
        out.push(resolveActionFieldRefs(a, ownDetail as never));
      }
    }
    return out;
  }

  /** Fetch one rule by id. The API exposes no single-GET automation endpoint —
   * only the database's list — so this reads the list and picks the row out,
   * 404-ing with a clear message (not a silent undefined) when the id is unknown. */
  async function fetchAutomation(wsId: string, dbId: string, id: string): Promise<AutomationRow> {
    const res = await unwrap<{ data?: AutomationRow[] }>(
      client.GET('/api/v1/workspaces/{ws}/databases/{db}/automations', {
        params: { path: { ws: wsId, db: dbId } },
      } as never),
    );
    const row = (res.data ?? []).find((r) => r.id === id);
    if (!row) throw new Error(`No automation "${id}" on this database. Use list_automations to see the rule ids.`);
    return row;
  }

  /** Build the map of database-id → display name for read-side annotation. */
  async function databaseNames(wsId: string): Promise<Map<string, string>> {
    const dbs = await listDatabases(client, wsId);
    return new Map(dbs.map((d) => [d.id, d.qualifiedSlug ?? d.name]));
  }

  /** The newest run for a rule (its "last-run status"), or null if it never ran. */
  async function lastRunFor(wsId: string, dbId: string, ruleId: string): Promise<LastRun | null> {
    const res = await unwrap<{ data?: Array<Record<string, unknown>> }>(
      client.GET('/api/v1/workspaces/{ws}/databases/{db}/automations/{id}/runs', {
        params: { path: { ws: wsId, db: dbId, id: ruleId } },
      } as never),
    ).catch(() => ({ data: [] as Array<Record<string, unknown>> }));
    const row = res.data?.[0];
    if (!row) return null;
    return {
      status: String(row.status),
      error: (row.error as string | null) ?? null,
      created_at: (row.createdAt as string | null) ?? null,
      duration_ms: (row.durationMs as number | null) ?? null,
    };
  }

  reg(
    'list_automations',
    {
      title: 'List automations',
      description:
        '#334: the automation rules on one database — each with its trigger (field/relation names resolved), condition, actions, ' +
        'enabled state, failure streak and last-run status. Automations are an admin surface, so this needs an admin-scoped token. ' +
        'Use get_automation for one rule\'s full editable definition.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
      },
    },
    handle<{ workspace: string; database: string }>(async ({ workspace, database }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const res = await unwrap<{ data?: AutomationRow[] }>(
        client.GET('/api/v1/workspaces/{ws}/databases/{db}/automations', {
          params: { path: { ws: ws.id, db: db.id } },
        } as never),
      );
      const rules = res.data ?? [];
      const dbNames = await databaseNames(ws.id);
      const rows = await Promise.all(
        rules.map(async (r) => {
          const lastRun = await lastRunFor(ws.id, db.id, r.id);
          return readableAutomation(r, detail as never, {
            databaseNamesById: dbNames,
            lastRun,
            workspaceSlug: ws.slug,
            webOrigin: ctx.baseUrl,
          });
        }),
      );
      return text({ automations: rows });
    }),
  );

  reg(
    'get_automation',
    {
      title: 'Get automation',
      description:
        "#334: one automation rule's full, editable definition — trigger, condition and actions with human-readable database/field/" +
        'select names alongside their stable ids, plus enabled state and last-run status. Feed the same shape back into update_automation.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        automation: z.string().describe('Automation rule id (from list_automations).'),
      },
    },
    handle<{ workspace: string; database: string; automation: string }>(async ({ workspace, database, automation }) => {
      const ws = await resolveWorkspace(client, workspace);
      const db = await resolveDatabase(client, ws.id, database);
      const detail = await getDetail(ws.id, db.id);
      const row = await fetchAutomation(ws.id, db.id, automation);
      const dbNames = await databaseNames(ws.id);
      const lastRun = await lastRunFor(ws.id, db.id, row.id);
      return text(
        readableAutomation(row, detail as never, {
          databaseNamesById: dbNames,
          lastRun,
          workspaceSlug: ws.slug,
          webOrigin: ctx.baseUrl,
        }),
      );
    }),
  );

  reg(
    'create_automation',
    {
      title: 'Create automation',
      description:
/*
         * #393 — the capability sentence comes FIRST, in words.
         *
         * Everything below was already accurate and a careful reviewer with
         * docs and MCP access still concluded that scheduled rules could not
         * call a webhook and that email was "genuinely missing". Both false.
         * They then acted on it: the plan routed around outbound HTTP and
         * treated email as a blocker.
         *
         * The failure was not absence, it was a dense slash-separated list —
         * "email" and "http_request" among fifteen tokens do not read as "send
         * real email" and "call any API". So the three capabilities people
         * assume are missing are stated as a sentence before the grammar
         * starts, where they cannot be skimmed past.
         */
        'A rule CAN REACH OUTSIDE STORYOS: it can SEND EMAIL (send_email, via a Resend or SMTP connection — the connection\'s own verified address sends it), ' +
        'CALL ANY HTTP API (http_request — any method, templated URL and body, optional auth via a connection, and it can capture JSON from the response back onto fields), ' +
        'and POST TO SLACK (send_slack_message). These work from SCHEDULED and TRIGGERED rules, not only from buttons — a button and a rule share one action schema, so anything one can do the other can. ' +
        'Private and internal addresses are refused on http_request (SSRF guard); public ones are fine. ' +
        '#334: create an automation rule = trigger + optional condition + 1–10 actions. TRIGGERS: ' +
        '{type:"record_created"} · {type:"record_updated", field?:"<name>"} · ' +
        // #297: `direction` shipped in #270 but was undocumented AND silently dropped.
        '{type:"record_linked", relation_field:"<name>", direction?:"link"|"unlink"} (omit direction to fire on both) · ' +
        '{type:"schedule", every:"hour"|"day"|"week", at?:"HH:MM", weekday?:0-6} · {type:"webhook_received"}. ' +
        'ACTIONS (array): set_values{values} · create_record{database, values, link_via_relation_field?} · ' +
        // #246 + #297: create_records was reachable but undocumented, and its target db needed a raw uuid.
        'create_records{database, count, values, link_via_relation_field?} — batch-create `count` records, where count is a number ' +
        'or a {token} resolved at run time (max 200); use {index} in templates for the 1-based position · ' +
        'add_comment{body_template} · ' +
        'notify_user{user:"@me"|"<person field>", message} · update_linked{relation_field, values} · send_slack_message{text, channel?} · ' +
        'send_webhook{url, body_template?, headers?} · send_email{connection_id, to, subject, body_markdown} · ' +
        'http_request{method, url, headers?, body_template?, connection_id?, capture?:[{path, target_field}]} · ' +
        'run_agent{agent, prompt?, ...}. ' +
        // #245: per-action condition — shipped, previously undocumented here.
        'ANY action also takes an optional `condition` (a filter AST, same shape as query_records) — that ONE action is SKIPPED when it ' +
        'does not match, and the rest of the rule still runs. NOTE: an action condition is passed through raw, so it must use api_names ' +
        '(not display names); the API validates it. ' +
        // #244 + #273: template tokens that exist but were not listed anywhere an agent looks.
        'TEMPLATE TOKENS usable in any templated field: {Field Name} for the triggering record · {linked.Field Name} for the record that ' +
        'was just linked/unlinked (record_linked triggers) · {changesSummary} renders "State: Urgent → Done" · {index} inside create_records. ' +
        'Field/relation/person names and select labels resolve server-side; describe_database first. ' +
        'The API validates the whole rule and returns a structured error for any bad reference. Rules are enabled by default.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id (the rule\'s home database).'),
        name: z.string().describe('Human name for the rule.'),
        trigger: z.any().describe('Trigger object — see the tool description for the shapes. record_linked accepts direction:"link"|"unlink".'),
        actions: z.any().describe('Array of 1–10 action objects — see the tool description. Each may carry its own optional `condition` (api_names).'),
        condition: z
          .any()
          .optional()
          .describe('Optional filter AST (same shape as query_records) — the rule only runs on records that match. Not allowed on webhook_received.'),
        enabled: z.boolean().optional().describe('Start enabled (default true).'),
        approver: z.string().optional().describe('User id who approves this rule\'s require_approval actions (defaults to the rule owner).'),
      },
    },
    handle<{ workspace: string; database: string; name: string; trigger: unknown; actions: unknown; condition?: unknown; enabled?: boolean; approver?: string }>(
      async ({ workspace, database, name, trigger, actions, condition, enabled, approver }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const body: Record<string, unknown> = {
          name,
          // #334: coerce before building — these arrive JSON-encoded from
          // clients that serialise object arguments.
          trigger: buildAutomationTrigger(parseStructuredParam(trigger, 'trigger') as TriggerInput, detail as never),
          actions: await resolveAutomationActions(parseStructuredParam(actions, 'actions'), detail, ws.id),
        };
        if (condition !== undefined && condition !== null) body.condition = mapFilterValues(detail, condition);
        if (enabled !== undefined) body.enabled = enabled;
        if (approver !== undefined) body.approverId = approver;
        const row = await unwrap<AutomationRow>(
          client.POST('/api/v1/workspaces/{ws}/databases/{db}/automations', {
            params: { path: { ws: ws.id, db: db.id } },
            body: body as never,
          }),
        );
        const dbNames = await databaseNames(ws.id);
        return text(
          readableAutomation(row, detail as never, { databaseNamesById: dbNames, workspaceSlug: ws.slug, webOrigin: ctx.baseUrl }),
        );
      },
    ),
  );

  reg(
    'update_automation',
    {
      title: 'Update automation',
      description:
        '#334: edit an existing rule — rename, enable/disable, or replace its trigger / condition / actions. Every field is ' +
        'optional; omit what you are not changing. To disable a rule pass { enabled: false }. Trigger and action shapes match ' +
        'create_automation (names/labels resolve server-side), INCLUDING record_linked\'s direction:"link"|"unlink" and each ' +
        // #297: get_automation → update_automation used to ERASE the direction on a
        // rule created in the UI, because the write side dropped it. Say it is kept.
        'action\'s optional `condition`. Replacing a trigger replaces it WHOLE — read it with get_automation first and pass back ' +
        'the parts you want to keep (direction included), or they are dropped. Pass condition: null to clear a condition. ' +
        'Re-validated the same way.',
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        automation: z.string().describe('Automation rule id (from list_automations).'),
        name: z.string().optional(),
        trigger: z.any().optional().describe('Replacement trigger (see create_automation).'),
        actions: z.any().optional().describe('Replacement actions array (see create_automation).'),
        condition: z.any().optional().describe('Replacement filter AST, or null to clear it.'),
        enabled: z.boolean().optional().describe('Enable (true) or disable (false) the rule.'),
        approver: z.string().nullable().optional().describe('Approver user id, or null to revert to the rule owner.'),
      },
    },
    handle<{ workspace: string; database: string; automation: string; name?: string; trigger?: unknown; actions?: unknown; condition?: unknown; enabled?: boolean; approver?: string | null }>(
      async ({ workspace, database, automation, name, trigger, actions, condition, enabled, approver }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        // #334: same coercion as create_automation — a rule read back from
        // list_automations must be passable straight into update_automation.
        if (trigger !== undefined)
          body.trigger = buildAutomationTrigger(parseStructuredParam(trigger, 'trigger') as TriggerInput, detail as never);
        if (actions !== undefined)
          body.actions = await resolveAutomationActions(parseStructuredParam(actions, 'actions'), detail, ws.id);
        if (condition !== undefined)
          body.condition = condition === null ? null : mapFilterValues(detail, parseStructuredParam(condition, 'condition'));
        if (enabled !== undefined) body.enabled = enabled;
        if (approver !== undefined) body.approverId = approver;
        const row = await unwrap<AutomationRow>(
          client.PATCH('/api/v1/workspaces/{ws}/databases/{db}/automations/{id}', {
            params: { path: { ws: ws.id, db: db.id, id: automation } },
            body: body as never,
          }),
        );
        const dbNames = await databaseNames(ws.id);
        const lastRun = await lastRunFor(ws.id, db.id, row.id);
        return text(
          readableAutomation(row, detail as never, { databaseNamesById: dbNames, lastRun, workspaceSlug: ws.slug, webOrigin: ctx.baseUrl }),
        );
      },
    ),
  );

  reg(
    'delete_automation',
    {
      title: 'Delete automation',
      description:
        '#334: permanently delete an automation rule. Requires explicit confirmation: pass confirm=true. Reports the deleted ' +
        "rule's name, trigger and action summary so the caller can see exactly what was removed. Its run history goes with it.",
      inputSchema: {
        workspace: z.string().describe('Workspace name or id.'),
        database: z.string().describe('Database name, api slug, or id.'),
        automation: z.string().describe('Automation rule id (from list_automations).'),
        confirm: z.boolean().describe('Must be true — deleting a rule is irreversible.'),
      },
    },
    handle<{ workspace: string; database: string; automation: string; confirm?: boolean }>(
      async ({ workspace, database, automation, confirm }) => {
        const ws = await resolveWorkspace(client, workspace);
        const db = await resolveDatabase(client, ws.id, database);
        const detail = await getDetail(ws.id, db.id);
        // Read the rule first so the confirmation gate can report what would be
        // removed (and so a bad id 404s here, before any destructive call).
        const row = await fetchAutomation(ws.id, db.id, automation);
        const affected = {
          id: row.id,
          name: row.name,
          trigger: row.trigger,
          actions: annotateActions(row.actions, detail as never),
        };
        if (confirm !== true) {
          return text({
            deleted: false,
            confirm_required: true,
            message: `Set confirm=true to delete automation "${row.name}". This is irreversible and removes its run history.`,
            affected,
          });
        }
        await unwrap<unknown>(
          client.DELETE('/api/v1/workspaces/{ws}/databases/{db}/automations/{id}', {
            params: { path: { ws: ws.id, db: db.id, id: automation } },
          } as never),
        );
        return text({ deleted: true, affected });
      },
    ),
  );
}
