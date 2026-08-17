import { describe, expect, it } from 'vitest';
import { createAutomationSchema, updateAutomationSchema } from '@storyos/schemas';
import {
  annotateActions,
  annotateTrigger,
  buildAutomationTrigger,
  readableAutomation,
  resolveActionFieldRefs,
  resolveValueMap,
  type AutoDetail,
} from './automations.js';
import { registerTools } from './tools.js';
import type { Ctx, EffectiveScope } from './client.js';

// A database with a select, a person field, and a relation — the field kinds the
// automation refs care about. Real-uuid-shaped ids so a resolved body validates
// against the same createAutomationSchema the Nest controller uses.
const STATE = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const REL = '33333333-3333-4333-8333-333333333333';
const TASKS_DB = '44444444-4444-4444-8444-444444444444';
const detail: AutoDetail = {
  id: 'db-1',
  name: 'Issues',
  qualifiedSlug: 'eng/issues',
  fields: [
    { id: STATE, apiName: 'state', displayName: 'State', type: 'select', options: [
      { id: 'opt-todo', label: 'To Do' },
      { id: 'opt-done', label: 'Done' },
    ] },
    { id: OWNER, apiName: 'owner', displayName: 'Owner', type: 'user' },
    { id: REL, apiName: 'project', displayName: 'Project', type: 'relation' },
    { id: 'ttl', apiName: 'title', displayName: 'Title', type: 'title' },
  ],
};

describe('buildAutomationTrigger (#334)', () => {
  it('resolves a record_updated watched field by display name to its id', () => {
    expect(buildAutomationTrigger({ type: 'record_updated', field: 'State' }, detail)).toEqual({
      type: 'record_updated',
      field_id: STATE,
    });
  });

  it('allows an unqualified record_updated (fires on any field change)', () => {
    expect(buildAutomationTrigger({ type: 'record_updated' }, detail)).toEqual({ type: 'record_updated' });
  });

  it('resolves a record_linked relation field by api_name', () => {
    expect(buildAutomationTrigger({ type: 'record_linked', relation_field: 'project' }, detail)).toEqual({
      type: 'record_linked',
      relation_field_id: REL,
    });
  });

  // #297: `direction` (#270) was silently DROPPED here — the rule saved without it
  // and fired on link AND unlink, i.e. ran side-effecting actions at the exact
  // moments the author excluded, with a success receipt and no warning.
  it('passes a record_linked direction through', () => {
    expect(buildAutomationTrigger({ type: 'record_linked', relation_field: 'project', direction: 'unlink' }, detail)).toEqual({
      type: 'record_linked',
      relation_field_id: REL,
      direction: 'unlink',
    });
    expect(buildAutomationTrigger({ type: 'record_linked', relation_field: 'project', direction: 'link' }, detail)).toEqual({
      type: 'record_linked',
      relation_field_id: REL,
      direction: 'link',
    });
  });

  it('omits direction when not asked for, so the rule fires on both', () => {
    expect(buildAutomationTrigger({ type: 'record_linked', relation_field: 'project' }, detail)).not.toHaveProperty('direction');
  });

  it('rejects a bad direction instead of dropping it', () => {
    // The failure mode being prevented: a typo silently becoming "fire on both".
    expect(() =>
      buildAutomationTrigger({ type: 'record_linked', relation_field: 'project', direction: 'unlinked' }, detail),
    ).toThrow(/must be "link" or "unlink"/);
  });

  it('round-trips a direction read back from get_automation', () => {
    // annotateTrigger is the read side; a get → update cycle must not erase it.
    const saved = buildAutomationTrigger({ type: 'record_linked', relation_field: 'project', direction: 'unlink' }, detail);
    const readBack = annotateTrigger(saved, detail)!;
    expect(readBack.direction).toBe('unlink');
    expect(
      buildAutomationTrigger(readBack as never, detail),
    ).toEqual(saved);
  });

  it('builds a schedule trigger verbatim', () => {
    expect(buildAutomationTrigger({ type: 'schedule', every: 'week', at: '09:00', weekday: 1 }, detail)).toEqual({
      type: 'schedule',
      every: 'week',
      at: '09:00',
      weekday: 1,
    });
  });

  it('throws a structured error naming the type set on an unknown trigger', () => {
    expect(() => buildAutomationTrigger({ type: 'nope' } as never, detail)).toThrow(/Unknown trigger type "nope"/);
  });

  it('throws naming candidate fields when the watched field does not exist', () => {
    expect(() => buildAutomationTrigger({ type: 'record_updated', field: 'ghost' }, detail)).toThrow(
      /No watched field matches "ghost".*state/,
    );
  });

  it('rejects a record_linked with no relation field', () => {
    expect(() => buildAutomationTrigger({ type: 'record_linked' }, detail)).toThrow(/needs a "relation_field"/);
  });
});

describe('resolveValueMap (#334)', () => {
  it('maps a display-name key to its api_name and a select label to the option id', () => {
    expect(resolveValueMap(detail, { State: 'Done' })).toEqual({ state: 'opt-done' });
  });

  it('keeps the name title-shortcut verbatim', () => {
    expect(resolveValueMap(detail, { name: 'Hello' })).toEqual({ name: 'Hello' });
  });

  it('throws naming valid fields on an unknown key', () => {
    expect(() => resolveValueMap(detail, { nope: 1 })).toThrow(/unknown field "nope".*state, owner/);
  });
});

describe('resolveActionFieldRefs (#334)', () => {
  it('resolves update_linked relation_field name → relation_field_id', () => {
    expect(resolveActionFieldRefs({ type: 'update_linked', relation_field: 'Project', values: {} }, detail)).toEqual({
      type: 'update_linked',
      relation_field_id: REL,
      values: {},
    });
  });

  it('resolves an http_request capture target_field name → target_field_id', () => {
    const out = resolveActionFieldRefs(
      { type: 'http_request', method: 'GET', url: 'https://x', capture: [{ path: 'a.b', target_field: 'State' }] },
      detail,
    );
    expect(out.capture).toEqual([{ path: 'a.b', target_field_id: STATE }]);
  });

  it('resolves notify_user person field name → api_name, leaving @me alone', () => {
    expect(resolveActionFieldRefs({ type: 'notify_user', user: 'Owner', message: 'hi' }, detail)).toMatchObject({
      user: 'owner',
    });
    expect(resolveActionFieldRefs({ type: 'notify_user', user: '@me', message: 'hi' }, detail)).toMatchObject({
      user: '@me',
    });
  });

  it('maps set_values through resolveValueMap', () => {
    expect(resolveActionFieldRefs({ type: 'set_values', values: { State: 'To Do' } }, detail)).toEqual({
      type: 'set_values',
      values: { state: 'opt-todo' },
    });
  });

  it('passes an unrelated action (send_webhook) through untouched', () => {
    const a = { type: 'send_webhook', url: 'https://hook', body_template: '{Title}' };
    expect(resolveActionFieldRefs(a, detail)).toEqual(a);
  });
});

describe('annotate + readableAutomation (#334)', () => {
  it('injects a field_name next to a trigger field_id', () => {
    expect(annotateTrigger({ type: 'record_updated', field_id: STATE }, detail)).toEqual({
      type: 'record_updated',
      field_id: STATE,
      field_name: 'State',
    });
  });

  it('marks a dangling (deleted) field reference with a null name', () => {
    expect(annotateTrigger({ type: 'record_updated', field_id: 'gone' }, detail)).toEqual({
      type: 'record_updated',
      field_id: 'gone',
      field_name: null,
    });
  });

  it('annotates action database_id and capture target ids', () => {
    const out = annotateActions(
      [
        { type: 'create_record', database_id: 'db-9', values: {} },
        { type: 'http_request', capture: [{ path: 'x', target_field_id: STATE }] },
      ],
      detail,
      new Map([['db-9', 'ops/tasks']]),
    ) as Array<Record<string, unknown>>;
    expect(out[0]!.database_name).toBe('ops/tasks');
    expect((out[1]!.capture as Array<Record<string, unknown>>)[0]!.target_field_name).toBe('State');
  });

  it('produces a curated read shape and never leaks a hook secret', () => {
    const row = {
      id: 'r1',
      name: 'Nightly',
      enabled: true,
      trigger: { type: 'webhook_received' },
      condition: null,
      actions: [],
      failureStreak: 2,
      nextDueAt: null,
      createdBy: 'user-1',
      hookToken: 'tok123',
      hookSecret: 'whin_supersecret',
      lastHookPayload: { a: 1 },
    };
    const out = readableAutomation(row, detail, {
      workspaceSlug: 'acme',
      webOrigin: 'https://api.test',
      lastRun: { status: 'ok' },
    });
    expect(out.webhook_url).toBe('https://api.test/api/v1/hooks/acme/tok123');
    expect(out.failure_streak).toBe(2);
    expect(out.last_run).toEqual({ status: 'ok' });
    expect(JSON.stringify(out)).not.toContain('whin_supersecret');
    expect(JSON.stringify(out)).not.toContain('lastHookPayload');
  });
});

// ============ Integration: the real tool handlers over a fake API client ============
//
// Mirrors tools.test.ts's query_records harness: a fake McpServer that just captures
// handlers, and a fake client whose /automations POST validates the body with the SAME
// createAutomationSchema the Nest controller's DTO uses — so a body the MCP would 422 on
// in production fails here too. Proves the human→id resolution yields an API-valid rule.

interface Row {
  id: string;
  name: string;
  enabled: boolean;
  trigger: unknown;
  condition: unknown;
  actions: unknown;
  failureStreak: number;
  nextDueAt: string | null;
  createdBy: string | null;
  hookToken: string | null;
}

function makeCtx(store: Row[]) {
  const wsList = [{ id: 'ws-1', name: 'Eng', slug: 'eng' }];
  const dbList = [
    { id: 'db-1', name: 'Issues', apiSlug: 'issues', spaceSlug: 'eng', qualifiedSlug: 'eng/issues' },
    // #297: a SECOND database with a real-uuid id, so a create_record(s) action's
    // target-database-by-name resolution is observable (and passes the API's uuid
    // check) rather than resolving to the rule's own database by accident.
    { id: TASKS_DB, name: 'Tasks', apiSlug: 'tasks', spaceSlug: 'eng', qualifiedSlug: 'eng/tasks' },
  ];
  const client = {
    GET: async (path: string) => {
      if (path === '/api/v1/workspaces') return { data: wsList };
      if (path === '/api/v1/workspaces/{ws}/databases') return { data: dbList };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}') return { data: detail };
      // These two endpoints return a { data: [...] } BODY, which openapi-fetch then
      // wraps again as { data: <body> } — hence the double nesting the handlers unwrap.
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/automations') return { data: { data: store } };
      if (path === '/api/v1/workspaces/{ws}/databases/{db}/automations/{id}/runs') {
        return { data: { data: [{ status: 'ok', error: null, createdAt: '2026-07-25T00:00:00Z', durationMs: 12 }] } };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    POST: async (path: string, opts: { body: unknown }) => {
      if (path !== '/api/v1/workspaces/{ws}/databases/{db}/automations') throw new Error(`unexpected POST ${path}`);
      // The exact zod the real controller validates with — proves the resolved body is API-valid.
      const parsed = createAutomationSchema.parse(opts.body);
      const row: Row = {
        id: 'new-rule',
        name: parsed.name,
        enabled: parsed.enabled,
        trigger: parsed.trigger,
        condition: parsed.condition ?? null,
        actions: parsed.actions,
        failureStreak: 0,
        nextDueAt: null,
        createdBy: 'user-1',
        hookToken: parsed.trigger.type === 'webhook_received' ? 'tok-xyz' : null,
      };
      store.push(row);
      return { data: row };
    },
    PATCH: async (path: string, opts: { body: unknown; params: { path: { id: string } } }) => {
      updateAutomationSchema.parse(opts.body);
      const row = store.find((r) => r.id === opts.params.path.id)!;
      Object.assign(row, opts.body);
      return { data: row };
    },
    DELETE: async () => ({ data: { deleted: true } }),
  };
  return { client, baseUrl: 'http://api.test', token: 't' } as unknown as Ctx;
}

function fakeServer() {
  const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const server = { registerTool: (name: string, _c: unknown, h: never) => handlers.set(name, h as never) };
  return { server: server as never, handlers };
}

async function call(handlers: Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>, name: string, args: unknown) {
  const h = handlers.get(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  const res = await h(args);
  return { res, json: () => JSON.parse(res.content[0]!.text) };
}

describe('automation tools end-to-end (#334)', () => {
  it('create_automation resolves a state-change trigger + set_values action to an API-valid rule', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { res, json } = await call(handlers, 'create_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      name: 'Close done',
      trigger: { type: 'record_updated', field: 'State' },
      actions: [{ type: 'set_values', values: { State: 'Done' } }],
      condition: { field: 'state', op: 'eq', value: 'To Do' },
    });
    expect(res.isError).toBeFalsy();
    const out = json();
    // The stored rule (validated by createAutomationSchema) got real ids…
    expect(store[0]!.trigger).toEqual({ type: 'record_updated', field_id: STATE });
    expect(store[0]!.actions).toEqual([{ type: 'set_values', values: { state: 'opt-done' } }]);
    // …and it read back with human-readable names alongside.
    expect((out.trigger as Record<string, unknown>).field_name).toBe('State');
  });

  // #297: before this, `direction` never reached the API — the stored rule fired on
  // link AND unlink.
  it('create_automation saves an unlink-only record_linked rule', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { res, json } = await call(handlers, 'create_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      name: 'On unlink only',
      trigger: { type: 'record_linked', relation_field: 'Project', direction: 'unlink' },
      actions: [{ type: 'add_comment', body_template: 'unlinked' }],
    });
    expect(res.isError).toBeFalsy();
    expect(store[0]!.trigger).toEqual({ type: 'record_linked', relation_field_id: REL, direction: 'unlink' });
    // …and it reads back, so a get → update cycle can't erase it.
    expect((json().trigger as Record<string, unknown>).direction).toBe('unlink');
  });

  it('create_automation surfaces a bad direction as a structured error, never a dropped field', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { res } = await call(handlers, 'create_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      name: 'Bad direction',
      trigger: { type: 'record_linked', relation_field: 'Project', direction: 'both' },
      actions: [{ type: 'add_comment', body_template: 'x' }],
    });
    expect(res.isError).toBe(true);
    expect(store).toHaveLength(0);
  });

  // #297: create_records (#246) was the ONLY action whose target database had to be
  // a raw uuid, because the resolver special-cased create_record alone.
  it('create_automation resolves a create_records target database BY NAME', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { res } = await call(handlers, 'create_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      name: 'Batch subtasks',
      trigger: { type: 'record_created' },
      actions: [
        {
          type: 'create_records',
          database: 'Tasks',
          count: 3,
          values: { State: 'Done' },
          link_via_relation_field: 'Project',
        },
      ],
    });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(store[0]!.actions).toEqual([
      {
        type: 'create_records',
        database_id: TASKS_DB,
        count: 3,
        values: { state: 'opt-done' }, // resolved against the TARGET database
        link_via_relation_field_id: REL,
      },
    ]);
  });

  it('leaves an unknown action key untouched so a new API capability still passes through', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { res } = await call(handlers, 'create_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      name: 'Conditional action',
      trigger: { type: 'record_created' },
      // #245's per-action condition is passed through raw (api_names) and validated
      // by the API — this pins that MCP does not strip it.
      actions: [{ type: 'add_comment', body_template: 'hi', condition: { field: 'state', op: 'eq', value: 'opt-done' } }],
    });
    expect(res.isError, JSON.stringify(store)).toBeFalsy();
    expect((store[0]!.actions as Array<Record<string, unknown>>)[0]!.condition).toEqual({
      field: 'state',
      op: 'eq',
      value: 'opt-done',
    });
  });

  it('create_automation supports a schedule trigger firing an action', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { res } = await call(handlers, 'create_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      name: 'Weekly ping',
      trigger: { type: 'schedule', every: 'week', at: '09:00', weekday: 1 },
      actions: [{ type: 'notify_user', user: '@me', message: 'weekly' }],
    });
    expect(res.isError).toBeFalsy();
    expect(store[0]!.trigger).toMatchObject({ type: 'schedule', every: 'week' });
  });

  it('surfaces an invalid field reference as a structured isError, not a throw/500', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { res } = await call(handlers, 'create_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      name: 'Bad',
      trigger: { type: 'record_updated', field: 'does-not-exist' },
      actions: [{ type: 'set_values', values: { State: 'Done' } }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/No watched field matches "does-not-exist"/);
    expect(store).toHaveLength(0);
  });

  it('list_automations reads rules back with last-run status', async () => {
    const store: Row[] = [
      { id: 'r1', name: 'A', enabled: true, trigger: { type: 'record_created' }, condition: null, actions: [], failureStreak: 0, nextDueAt: null, createdBy: 'u', hookToken: null },
    ];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const { json } = await call(handlers, 'list_automations', { workspace: 'Eng', database: 'eng/issues' });
    const out = json();
    expect(out.automations).toHaveLength(1);
    expect(out.automations[0].last_run).toEqual({ status: 'ok', error: null, created_at: '2026-07-25T00:00:00Z', duration_ms: 12 });
  });

  it('delete_automation refuses without confirm, then deletes with confirm=true', async () => {
    const store: Row[] = [
      { id: 'r1', name: 'A', enabled: true, trigger: { type: 'record_created' }, condition: null, actions: [], failureStreak: 0, nextDueAt: null, createdBy: 'u', hookToken: null },
    ];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    const gate = (await call(handlers, 'delete_automation', { workspace: 'Eng', database: 'eng/issues', automation: 'r1' })).json();
    expect(gate.deleted).toBe(false);
    expect(gate.confirm_required).toBe(true);
    const done = (await call(handlers, 'delete_automation', { workspace: 'Eng', database: 'eng/issues', automation: 'r1', confirm: true })).json();
    expect(done.deleted).toBe(true);
    expect(done.affected.name).toBe('A');
  });
});

describe('automation tool scope gating (#334)', () => {
  const names = ['list_automations', 'get_automation', 'create_automation', 'update_automation', 'delete_automation'];

  function registeredNames(scope: EffectiveScope['scope']): Set<string> {
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx([]), { scope, allowRunButton: true });
    return new Set(handlers.keys());
  }

  it('never advertises any automation tool to a read token (cannot mutate — or even see — rules)', () => {
    const reg = registeredNames('read');
    for (const n of names) expect(reg.has(n)).toBe(false);
  });

  it('never advertises the mutating automation tools to a write token', () => {
    const reg = registeredNames('write');
    for (const n of names) expect(reg.has(n)).toBe(false);
  });

  it('advertises every automation tool to an admin token', () => {
    const reg = registeredNames('admin');
    for (const n of names) expect(reg.has(n)).toBe(true);
  });
});

/**
 * #334 — the params arrive JSON-ENCODED from clients that serialise object
 * arguments. Every create_automation call from such a client died on
 * `trigger must be an object with a "type"`, which blamed a trigger that was
 * correct. query_records worked from the same client (mapFilterValues already
 * parsed strings), so the failure read like caller error rather than a gap.
 */
describe('structured params accept JSON strings (#334)', () => {
  const args = (over: Record<string, unknown>) => ({
    workspace: 'Eng',
    database: 'eng/issues',
    name: 'Close done',
    trigger: { type: 'record_updated', field: 'State' },
    actions: [{ type: 'set_values', values: { State: 'Done' } }],
    ...over,
  });

  it('behaves identically whether trigger/actions/condition are objects or JSON strings', async () => {
    const asObjects: Row[] = [];
    const a = fakeServer();
    registerTools(a.server, makeCtx(asObjects));
    await call(a.handlers, 'create_automation', args({ condition: { field: 'state', op: 'eq', value: 'To Do' } }));

    const asStrings: Row[] = [];
    const b = fakeServer();
    registerTools(b.server, makeCtx(asStrings));
    const { res } = await call(
      b.handlers,
      'create_automation',
      args({
        trigger: JSON.stringify({ type: 'record_updated', field: 'State' }),
        actions: JSON.stringify([{ type: 'set_values', values: { State: 'Done' } }]),
        condition: JSON.stringify({ field: 'state', op: 'eq', value: 'To Do' }),
      }),
    );

    expect(res.isError).toBeFalsy();
    expect(asStrings[0]!.trigger).toEqual(asObjects[0]!.trigger);
    expect(asStrings[0]!.actions).toEqual(asObjects[0]!.actions);
    expect(asStrings[0]!.condition).toEqual(asObjects[0]!.condition);
  });

  it('names the real problem when a string is not valid JSON', async () => {
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx([]));
    const { res } = await call(handlers, 'create_automation', args({ trigger: '{type: record_updated' }));
    expect(res.isError).toBe(true);
    // The old message accused the trigger of being the wrong SHAPE, which sent
    // the caller off rewriting a correct trigger.
    expect(res.content[0]!.text).toMatch(/isn't valid JSON/);
    expect(res.content[0]!.text).not.toMatch(/must be an object with a "type"/);
  });

  it('update_automation takes the same strings', async () => {
    const store: Row[] = [];
    const { server, handlers } = fakeServer();
    registerTools(server, makeCtx(store));
    await call(handlers, 'create_automation', args({}));
    const { res } = await call(handlers, 'update_automation', {
      workspace: 'Eng',
      database: 'eng/issues',
      automation: store[0]!.id,
      trigger: JSON.stringify({ type: 'record_created' }),
    });
    expect(res.isError).toBeFalsy();
    expect(store[0]!.trigger).toEqual({ type: 'record_created' });
  });
});

/**
 * #334 — a rule read back from list_automations/get_automation must be passable
 * straight into update_automation. It echoes `field_name`, which the builder
 * ignored: the rule silently widened from "when State changes" to "when
 * ANYTHING changes" — a success receipt for a rule that now fires far more often.
 */
describe('a read-back trigger round-trips (#334)', () => {
  it('accepts field_name, the name this tool itself prints', () => {
    expect(buildAutomationTrigger({ type: 'record_updated', field_name: 'State' }, detail)).toEqual({
      type: 'record_updated',
      field_id: STATE,
    });
  });

  it('accepts relation_field_name too', () => {
    expect(buildAutomationTrigger({ type: 'record_linked', relation_field_name: 'Project' }, detail)).toEqual({
      type: 'record_linked',
      relation_field_id: REL,
    });
  });

  it('treats an echoed null field_name as "watch every field", not as a bad reference', () => {
    // get_automation prints field_name: null for an unqualified record_updated.
    expect(buildAutomationTrigger({ type: 'record_updated', field_name: null } as never, detail)).toEqual({
      type: 'record_updated',
    });
  });

  it('prefers an explicit field over the echoed name when both are present', () => {
    expect(
      buildAutomationTrigger({ type: 'record_updated', field: 'Owner', field_name: 'State' }, detail),
    ).toEqual({ type: 'record_updated', field_id: OWNER });
  });
});
