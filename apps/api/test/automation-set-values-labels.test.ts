import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';

/**
 * #719 — an automation's `set_values` (and the other record-writing actions) could set a select / workflow / multi-select field only by
 * option ID. The label an admin sees and types when configuring the rule ("Done") failed the run with "unknown option id". Labels now
 * resolve the way the MCP layer's write mapping does (one shared function), ids still work, and an unknown label fails the run naming the
 * field and the valid labels.
 */
let app: NestFastifyApplication;
let engine: AutomationsService;
let token: string;
let ws: string;
let space: string;
const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

interface F { id: string; apiName: string; type: string; options?: Array<{ id: string; label: string }> }

/** A database with Status (select), State (workflow), Tags (multi_select), and a rule that fires on record_created. */
async function rigged(name: string, actions: unknown[] | ((db: string, f: { status: F; stage: F; tags: F }) => unknown[])) {
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  const mk = async (display_name: string, type: string, options?: string[]) =>
    (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name, type, config: {}, ...(options ? { options: options.map((label) => ({ label })) } : {}) })).json() as F;
  const status = await mk('Status', 'select', ['New', 'In review', 'Done']);
  const stage = await mk('Stage', 'workflow', ['Todo', 'Doing', 'Shipped']);
  const tags = await mk('Tags', 'multi_select', ['red', 'green', 'blue']);
  await mk('Points', 'number');
  const actionList = typeof actions === 'function' ? actions(db, { status, stage, tags }) : actions;
  const rule = (await as('POST', `/workspaces/${ws}/databases/${db}/automations`, { name: `rule ${name}`, trigger: { type: 'record_created' }, actions: actionList })).json();
  expect(rule.id, JSON.stringify(rule)).toBeTruthy();
  const fire = async (values: Record<string, unknown> = { name: 'card' }) => {
    const rec = (await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values })).json() as { id: string };
    await engine.settle(rec.id);
    const runs = (await as('GET', `/workspaces/${ws}/databases/${db}/automations/${rule.id}/runs`)).json().data as Array<{ status: string; error?: string }>;
    const after = (await as('GET', `/workspaces/${ws}/databases/${db}/records/${rec.id}`)).json() as { values: Record<string, unknown> };
    return { runs, values: after.values };
  };
  const idOf = (f: F, label: string) => f.options!.find((o) => o.label === label)!.id;
  return { db, status, stage, tags, fire, idOf };
}

beforeAll(async () => {
  app = await createTestApp();
  engine = app.get(AutomationsService);
  token = (await signUpUser(app, 'Labels')).token;
  ws = (await as('POST', '/workspaces', { name: 'Labels WS' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#719 set_values by LABEL', () => {
  it('a select, a workflow and a multi-select set by their labels land as the right options', async () => {
    const r = await rigged('by label', [{ type: 'set_values', values: { status: 'Done', stage: 'Doing', tags: ['red', 'blue'] } }]);
    const out = await r.fire();
    expect(out.runs.map((x) => x.status), out.runs.map((x) => x.error).join(' | ')).toEqual(['ok']);
    expect(out.values['status']).toBe(r.idOf(r.status, 'Done'));
    expect(out.values['stage']).toBe(r.idOf(r.stage, 'Doing'));
    expect(out.values['tags']).toEqual([r.idOf(r.tags, 'red'), r.idOf(r.tags, 'blue')]);
  });

  it('a label matches case-insensitively, as it does over MCP', async () => {
    const r = await rigged('case', [{ type: 'set_values', values: { status: 'in REVIEW' } }]);
    const out = await r.fire();
    expect(out.runs[0]?.status, out.runs[0]?.error).toBe('ok');
    expect(out.values['status']).toBe(r.idOf(r.status, 'In review'));
  });

  it('an option ID still works exactly as before', async () => {
    const r = await rigged('by id', (_db, f) => [{ type: 'set_values', values: { status: f.status.options!.find((o) => o.label === 'Done')!.id } }]);
    const out = await r.fire();
    expect(out.runs[0]?.status, out.runs[0]?.error).toBe('ok');
    expect(out.values['status']).toBe(r.idOf(r.status, 'Done'));
  });
});

describe('#719 an unknown label fails the run, naming the field and the valid labels', () => {
  it('set_values with a label the field does not have', async () => {
    const r = await rigged('unknown label', [{ type: 'set_values', values: { status: 'Shipped' } }]);
    const out = await r.fire();
    expect(out.runs[0]?.status).toBe('error');
    const message = out.runs[0]?.error ?? '';
    expect(message, 'names the field').toMatch(/status/i);
    expect(message, 'names what was given').toContain('Shipped');
    for (const valid of ['New', 'In review', 'Done']) expect(message, 'and the valid labels').toContain(valid);
    expect(out.values['status'] ?? null, 'nothing was written').toBeNull();
  });

  it('an unknown label inside a multi-select', async () => {
    const r = await rigged('unknown tag', [{ type: 'set_values', values: { tags: ['red', 'purple'] } }]);
    const out = await r.fire();
    expect(out.runs[0]?.status).toBe('error');
    expect(out.runs[0]?.error).toContain('purple');
    expect(out.runs[0]?.error).toMatch(/red, green, blue|green/);
  });
});

describe('#719 the other record-writing actions agree', () => {
  it('create_record with a label creates the record with the option set', async () => {
    const own = await rigged('create_record', (db) => [{ type: 'create_record', database_id: db, values: { name: 'made by rule', status: 'Done' } }]);
    const rec = (await as('POST', `/workspaces/${ws}/databases/${own.db}/records`, { values: { name: 'trigger' } })).json() as { id: string };
    await engine.settle(rec.id);
    const list = (await as('POST', `/workspaces/${ws}/databases/${own.db}/records/query`, { limit: 20 })).json().data as Array<{ title: string; values: Record<string, unknown> }>;
    const made = list.find((r) => r.title === 'made by rule');
    expect(made, 'the rule created a record').toBeTruthy();
    expect(made!.values['status']).toBe(own.idOf(own.status, 'Done'));
  });
});

describe('#714 still holds: any REMAINING validation failure keeps its field-level reason in the run record', () => {
  it('a value that is neither a label nor valid for the field type', async () => {
    const r = await rigged('still field level', [{ type: 'set_values', values: { points: 'not a number' } }]);
    const out = await r.fire();
    expect(out.runs[0]?.status).toBe('error');
    expect(out.runs[0]?.error, 'the field is named').toContain('points');
    expect(out.runs[0]?.error, 'and so is the real reason, not a generic line').toMatch(/expects a number/i);
  });
});
