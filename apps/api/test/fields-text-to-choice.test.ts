import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CONVERTIBLE } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';

/**
 * #957 — a text field becomes select / multi_select / workflow: each distinct non-empty TRIMMED value is one option
 * (case-sensitive, never merged); a record's value maps to its option, empty stays empty; multi_select takes the whole
 * value as ONE option (no comma splitting). The dry run lists the options and writes nothing; past 200 distinct values
 * is refused naming the count.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, space: string;
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Choice Owner');
  ws = (await as('POST', '/workspaces', { name: 'Choice WS' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 240_000);
afterAll(async () => { await app.close(); });

/** A fresh database with a text `Status` field holding `values` (null = no value at all). One per test: a workflow is one-per-database. */
async function textDb(values: Array<string | null>) {
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: `Choice ${Math.random().toString(36).slice(2)}` })).json().id as string;
  const field = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Status', type: 'text' })).json();
  const ids: string[] = [];
  for (const [i, v] of values.entries()) {
    const res = await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: `r${i}`, ...(v === null ? {} : { status: v }) } });
    expect(res.statusCode, res.body).toBe(201);
    ids.push(res.json().id);
  }
  return { db, field: field.id as string, ids };
}
const change = (db: string, field: string, type: string, extra: Record<string, unknown> = {}) =>
  as('POST', `/workspaces/${ws}/databases/${db}/fields/${field}/change-type`, { type, ...extra });
const detail = async (db: string) => (await as('GET', `/workspaces/${ws}/databases/${db}`)).json();
const valuesOf = async (db: string, ids: string[]) =>
  Promise.all(ids.map(async (id) => (await as('GET', `/workspaces/${ws}/databases/${db}/records/${id}`)).json().values.status));
// 'todo' x2 (one padded), 'Todo' (a different option: case-sensitive), 'done', whitespace-only (empty), and a record with no value.
const MIXED = ['todo', '  todo ', 'Todo', 'done', '   ', null];

describe('#957 text → choice', () => {
  for (const target of ['select', 'workflow', 'multi_select'] as const) {
    it(`text → ${target}: one option per distinct trimmed value, values mapped, empty stays empty`, async () => {
      const { db, field, ids } = await textDb(MIXED);
      const res = await change(db, field, target);
      expect(res.statusCode, res.body).toBe(201);
      const f = (await detail(db)).fields.find((x: { id: string }) => x.id === field);
      expect(f.type).toBe(target);
      const options = f.options as Array<{ id: string; label: string }>;
      expect(options.map((o) => o.label).sort()).toEqual(['Todo', 'done', 'todo']);
      const id = (label: string) => options.find((o) => o.label === label)!.id;
      const wrap = (label: string) => (target === 'multi_select' ? [id(label)] : id(label));
      const got = await valuesOf(db, ids);
      expect(got[0]).toEqual(wrap('todo'));
      expect(got[1], 'leading/trailing spaces are trimmed into the SAME option').toEqual(wrap('todo'));
      expect(got[2], 'case-sensitive: Todo is its own option').toEqual(wrap('Todo'));
      expect(got[3]).toEqual(wrap('done'));
      expect(got[4] ?? null, 'whitespace-only is empty').toBeNull();
      expect(got[5] ?? null, 'no value stays no value').toBeNull();
    });
  }

  it('multi_select does NOT split on commas: "a, b" is one option', async () => {
    const { db, field } = await textDb(['a, b', 'a']);
    expect((await change(db, field, 'multi_select')).statusCode).toBe(201);
    const labels = (await detail(db)).fields.find((x: { id: string }) => x.id === field).options.map((o: { label: string }) => o.label).sort();
    expect(labels).toEqual(['a', 'a, b']);
  });

  it('the dry run lists the options with a count each and the empty records — and writes NOTHING', async () => {
    const { db, field, ids } = await textDb(MIXED);
    const res = await change(db, field, 'select', { dry_run: true });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.dry_run).toBe(true);
    expect(body.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'todo', records: 2 }),
      expect.objectContaining({ label: 'Todo', records: 1 }),
      expect.objectContaining({ label: 'done', records: 1 }),
    ]));
    expect(body.options).toHaveLength(3);
    expect(body.empty_records).toBe(1); // the whitespace-only one; a record with no key is not read at all
    // nothing written: still text, no options, values untouched
    const f = (await detail(db)).fields.find((x: { id: string }) => x.id === field);
    expect(f.type).toBe('text');
    expect(f.options ?? []).toHaveLength(0);
    expect(await valuesOf(db, ids)).toEqual(['todo', '  todo ', 'Todo', 'done', '   ', undefined]);
  });

  it('more than 200 distinct values is refused, naming the count — dry run and apply — and nothing is written', async () => {
    const { db, field, ids } = await textDb(Array.from({ length: 201 }, (_, i) => `v${i}`));
    for (const dry_run of [true, false]) {
      const res = await change(db, field, 'select', { dry_run });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.message).toContain('201 distinct values');
    }
    expect((await detail(db)).fields.find((x: { id: string }) => x.id === field).type).toBe('text');
    expect((await valuesOf(db, ids))[0]).toBe('v0');
  }, 120_000);

  it('exactly 200 distinct values is allowed', async () => {
    const { db, field } = await textDb(Array.from({ length: 200 }, (_, i) => `v${i}`));
    expect((await change(db, field, 'select', { dry_run: true })).statusCode).toBe(201);
  }, 120_000);

  it('a workflow target keeps the one-workflow-per-database rule', async () => {
    const { db, field } = await textDb(['x']);
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Stage', type: 'workflow', options: [{ label: 'New', color: 'gray' }] })).statusCode).toBe(201);
    const res = await change(db, field, 'workflow');
    expect(res.statusCode, res.body).toBe(409);
    expect((await detail(db)).fields.find((x: { id: string }) => x.id === field).type).toBe('text');
  });

  it('authz: schema ops need creator (ADR-0007) — a guest with only a viewer grant is refused, a person with no access gets 404, and nothing changes', async () => {
    const { db, field } = await textDb(['x']);
    const viewer = await joinAs(app, owner.token, ws, 'Choice Viewer', 'guest', [{ database_id: db, role: 'viewer' }]);
    const elsewhere = (await textDb(['y'])).db;
    const stranger = await joinAs(app, owner.token, ws, 'Choice Stranger', 'guest', [{ database_id: elsewhere, role: 'viewer' }]);
    const url = `/workspaces/${ws}/databases/${db}/fields/${field}/change-type`;
    for (const dry_run of [true, false]) {
      const asViewer = await call(app, viewer.token, 'POST', url, { type: 'select', dry_run });
      expect(asViewer.statusCode, asViewer.body).toBe(403);
      const asStranger = await call(app, stranger.token, 'POST', url, { type: 'select', dry_run });
      expect(asStranger.statusCode, asStranger.body).toBe(404);
    }
    expect((await detail(db)).fields.find((x: { id: string }) => x.id === field).type).toBe('text');
  });

  it('MUST KEEP WORKING: text → number, and the reverse select → text', async () => {
    const { db, field } = await textDb(['1.5']);
    expect((await change(db, field, 'number')).statusCode).toBe(201);
    const t = await textDb(['a']);
    expect((await change(t.db, t.field, 'select')).statusCode).toBe(201);
    expect((await change(t.db, t.field, 'text')).statusCode).toBe(201);
  });
});

describe('#957 one conversion matrix', () => {
  it('the web dialog keeps no copy of it: it imports the one in @storyos/schemas', () => {
    const shared = readFileSync(join(__dirname, '../../web/src/components/table-view/field-dialog-shared.tsx'), 'utf8');
    expect(shared).not.toMatch(/CONVERTIBLE\s*[:=]/);
    for (const f of ['change-type-dialog.tsx', 'edit-field-dialog.tsx']) {
      expect(readFileSync(join(__dirname, '../../web/src/components/table-view', f), 'utf8')).toContain("import { CONVERTIBLE } from '@storyos/schemas'");
    }
    expect(CONVERTIBLE.text).toEqual(expect.arrayContaining(['select', 'multi_select', 'workflow']));
  });
});
