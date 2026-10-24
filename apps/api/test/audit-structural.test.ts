import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { STRUCTURAL_EVENT_TYPES } from '../src/activity/structural-events';

/**
 * #1059 — "who deleted that database?" is the first question an admin asks, and the audit log could not answer it for a database, a view
 * or a space. Each test performs the action as a named person (over REST, and over a token the way MCP arrives) and then asks the AUDIT LOG
 * what it recorded: who, what object (name and id), when, and from which kind of actor.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let adminName: string;
let ws: string;
let space: string;
let dbId: string;
let defaultViewId: string;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

interface AuditRow { kind: string; type?: string; actor_name?: string | null; actor_id?: string | null; source?: string | null; credential_id?: string | null; object?: { kind: string; id: string; name: string } | null; payload?: Record<string, unknown>; created_at: string }
const audit = async (query = '') => {
  const res = await as(admin.token, 'GET', `/workspaces/${ws}/audit-log?limit=100${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data ?? res.json().events ?? res.json()) as AuditRow[];
};
const eventsOf = async (type: string, id?: string) => (await audit(`&type=${type}${id ? `&entity=${id}` : ''}`)).filter((e) => e.type === type);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Audit Admin');
  member = await signUpUser(app, 'Audit Member');
  adminName = 'Audit Admin';
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Audit WS' })).json().id;
  space = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Client Work' })).json().id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Invoices' })).json().id;
  const inv = await as(admin.token, 'POST', `/workspaces/${ws}/invites`, { email: member.email, role: 'member' });
  await as(member.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  defaultViewId = ((await as(admin.token, 'GET', `/workspaces/${ws}/databases/${dbId}`)).json().views as Array<{ id: string }>)[0]!.id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1059 a database, a view and a space: deleted, restored, restricted — each is in the audit log with who and what', () => {
  it('VIEW: delete and restore name the person, the view and its database', async () => {
    const view = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/views`, { name: 'Overdue', type: 'table', config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} } })).json();
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${dbId}/views/${view.id}`)).statusCode).toBe(200);
    const del = (await eventsOf('view.deleted', view.id))[0]!;
    expect(del).toMatchObject({ kind: 'event', type: 'view.deleted', actor_name: adminName, source: 'human', object: { kind: 'view', id: view.id, name: 'Overdue' } });
    expect(del.payload).toMatchObject({ database_name: 'Invoices', view_type: 'table' });
    expect(new Date(del.created_at).getTime(), 'a real time').toBeGreaterThan(Date.now() - 60_000);
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/views/${view.id}/restore`)).statusCode).toBeLessThan(300);
    expect((await eventsOf('view.restored', view.id))[0]).toMatchObject({ actor_name: adminName, object: { kind: 'view', id: view.id, name: 'Overdue' } });
  });

  it('DATABASE: restrict, unrestrict, delete and restore are each recorded; saving the SAME value is not an event', async () => {
    const d = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Contracts' })).json().id as string;
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${d}`, { restricted: true })).statusCode).toBe(200);
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${d}`, { restricted: true })).statusCode, 'no change').toBe(200);
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${d}`, { restricted: false })).statusCode).toBe(200);
    expect(await eventsOf('database.restricted', d), 'exactly one: the repeat was not a change').toHaveLength(1);
    expect(await eventsOf('database.unrestricted', d)).toHaveLength(1);
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${d}`, { confirm: 'Contracts' })).statusCode).toBe(200);
    expect((await eventsOf('database.deleted', d))[0]).toMatchObject({ actor_name: adminName, source: 'human', object: { kind: 'database', id: d, name: 'Contracts' } });
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/databases/${d}/restore`)).statusCode).toBeLessThan(300);
    expect((await eventsOf('database.restored', d))[0]).toMatchObject({ object: { id: d, name: 'Contracts' } });
  });

  it('SPACE: delete records what went with it; restore and restrict/unrestrict are recorded', async () => {
    const s = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Old Projects' })).json().id as string;
    const inner = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: s, name: 'Archive' })).json().id as string;
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/spaces/${s}`, { restricted: true })).statusCode).toBe(200);
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/spaces/${s}`, { restricted: false })).statusCode).toBe(200);
    expect(await eventsOf('space.restricted', s)).toHaveLength(1);
    expect(await eventsOf('space.unrestricted', s)).toHaveLength(1);
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/spaces/${s}`, { confirm: 'Old Projects' })).statusCode).toBe(200);
    const del = (await eventsOf('space.deleted', s))[0]!;
    expect(del).toMatchObject({ actor_name: adminName, object: { kind: 'space', id: s, name: 'Old Projects' } });
    expect(del.payload!.databases_deleted, 'the cascade is named, so "who deleted Archive?" has an answer').toEqual([{ id: inner, name: 'Archive' }]);
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/spaces/${s}/restore`)).statusCode).toBeLessThan(300);
    expect((await eventsOf('space.restored', s))[0]!.payload).toMatchObject({ databases_restored: 1 });
  });

  it('a SPACE-LEVEL view (dashboard) delete is recorded with its space', async () => {
    const s = (await as(admin.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Dash Space' })).json().id as string;
    const dash = await as(admin.token, 'POST', `/workspaces/${ws}/spaces/${s}/views`, { name: 'Overview', type: 'dashboard' });
    expect(dash.statusCode, dash.body).toBeLessThan(300);
    expect((await as(admin.token, 'DELETE', `/workspaces/${ws}/views/${dash.json().id}`)).statusCode).toBeLessThan(300);
    expect((await eventsOf('view.deleted', dash.json().id))[0]).toMatchObject({ object: { kind: 'view', name: 'Overview' }, payload: expect.objectContaining({ space_name: 'Dash Space' }) });
  });
});

describe('#1059 attribution: the same event arrives as REST or as MCP, and says which', () => {
  it('a delete made with a personal access token (how MCP arrives) is badged mcp and names the credential', async () => {
    const d = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Via MCP' })).json().id as string;
    const minted = (await as(admin.token, 'POST', '/me/tokens', { name: 'mcp-client', workspace_id: ws, scope: 'admin' })).json();
    const del = await as(minted.token, 'DELETE', `/workspaces/${ws}/databases/${d}`, { confirm: 'Via MCP' });
    expect(del.statusCode, del.body).toBe(200);
    const ev = (await eventsOf('database.deleted', d))[0]!;
    expect(ev).toMatchObject({ actor_name: adminName, source: 'mcp', object: { name: 'Via MCP' } });
    expect(ev.credential_id, 'and WHICH credential').toBe(minted.id);
  });
});

describe('#1059 what is NOT in the log, on purpose', () => {
  it('a PERSONAL view and a PERSONAL space are private from admins: deleting them writes no workspace event', async () => {
    const before = (await audit()).length;
    const pv = await as(member.token, 'POST', `/workspaces/${ws}/databases/${dbId}/views/personal`, { name: 'My secret lens', type: 'table', config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} } });
    expect(pv.statusCode, pv.body).toBeLessThan(300);
    expect((await as(member.token, 'DELETE', `/workspaces/${ws}/databases/${dbId}/views/${pv.json().id}`)).statusCode).toBe(200);
    expect(JSON.stringify(await audit()), 'the personal view is nowhere in the admin log').not.toContain('My secret lens');
    const personal = (await as(member.token, 'POST', `/workspaces/${ws}/spaces/personal`)).json().id as string;
    expect((await as(member.token, 'DELETE', `/workspaces/${ws}/spaces/${personal}`, { confirm: 'Personal' })).statusCode).toBeLessThan(500);
    expect((await audit()).filter((e) => e.type?.startsWith('space.') && e.object?.id === personal), 'nor the personal space').toHaveLength(0);
    expect((await audit()).length).toBeGreaterThanOrEqual(before); // sanity: the log itself still works
  });

  it('a member cannot read the log; the structural events are admin-only like the rest', async () => {
    expect((await as(member.token, 'GET', `/workspaces/${ws}/audit-log`)).statusCode).toBe(403);
  });
});

describe('#1059 filtering', () => {
  it('?type= narrows to the structural events (and leaves field changes out); ?entity= takes an object id', async () => {
    const onlyDeletes = await audit('&type=database.deleted,space.deleted,view.deleted');
    expect(onlyDeletes.length).toBeGreaterThan(0);
    expect(onlyDeletes.every((e) => e.kind === 'event' && /\.deleted$/.test(e.type ?? ''))).toBe(true);
    const some = onlyDeletes.find((e) => e.object)!;
    const byEntity = await audit(`&entity=${some.object!.id}`);
    expect(byEntity.length).toBeGreaterThan(0);
    expect(byEntity.every((e) => e.object?.id === some.object!.id || e.object === null)).toBe(true);
  });
});

describe('#1059 the vocabulary, and the day a purge appears', () => {
  it('every kind has deleted, restored, purged, restricted and unrestricted', () => {
    for (const k of ['space', 'database', 'view']) for (const a of ['deleted', 'restored', 'purged', 'restricted', 'unrestricted']) expect(STRUCTURAL_EVENT_TYPES).toContain(`${k}.${a}`);
  });

  /**
   * "Permanently purge" is in the ticket, but nothing in the codebase removes a space, database or view for good: every delete is a soft
   * delete (#453). The one place that hard-deletes them is a removed member's PERSONAL content (private from admins; personal-space.md).
   * If ANY other hard delete of these tables appears, this test fails, and the author must emit `<kind>.purged` before it can pass.
   */
  it('no code path hard-deletes a space, database or view except the removed-member PERSONAL cleanup (so no purge goes unlogged)', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          const text = readFileSync(p, 'utf8');
          for (const m of text.matchAll(/\.delete\(\s*(spaces|databases|views)\s*\)/g)) hits.push(`${p.replace(`${src}/`, '')}: ${m[0]}`);
        }
      }
    };
    walk(src);
    expect(hits.filter((h) => !h.startsWith('workspaces/members.service.ts')), `hard deletes with no purge event:\n${hits.join('\n')}`).toEqual([]);
  });
});
