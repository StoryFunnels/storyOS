import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { approvals, automationJobs } from '../src/db/schema';

/**
 * Ticket #1298 - ONE approval row whose stored snapshot cannot be read must not take the approvals list down for everyone.
 *
 * The snapshot of a row comes from a producer that has since changed shape (or from a hand-seeded test workspace): {"kind":"send_email"}
 * with no `ctx` was the real one. Every case here is a row the list used to choke on, or could. The assertions that matter are the
 * ones about what must SURVIVE: the good rows, in the same list, unchanged; and the rows a restricted guest may not see stay hidden.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string; id: string };
let member: { token: string; id: string };
let guest: { token: string; id: string };
let ws: string;
let tasks: string;
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

const seed = async (snapshot: unknown, over: Record<string, unknown> = {}) =>
  (
    await raw
      .insert(approvals)
      .values({
        workspaceId: ws,
        actionIndex: 0,
        actionSnapshot: snapshot === null ? sql`'null'::jsonb` : (snapshot as never),
        previewText: 'raw preview from the row',
        approverId: owner.id,
        ...over,
      } as never)
      .returning()
  )[0]!;

const MALFORMED: Array<[string, unknown]> = [
  ['the real one: {"kind":"send_email"} with no ctx and no action', { kind: 'send_email' }],
  ['a JSON null', null],
  ['a string', 'oops'],
  ['a number', 5],
  ['an array', []],
  ['an empty object', {}],
  ['an action but no ctx', { action: { type: 'send_email' } }],
  ['a ctx but no action', { ctx: { databaseId: 'x' } }],
  ['an action whose type is not a string', { action: { type: 5 }, ctx: { databaseId: 'x' } }],
  ['a null ctx', { action: { type: 'send_email' }, ctx: null }],
  ['a ctx whose databaseId is a number', { action: { type: 'send_email' }, ctx: { databaseId: 7 } }],
];

let good: { id: string };
let warn: ReturnType<typeof vi.spyOn>;
let malformedIds: string[] = [];
const list = async (token: string, qs = '') => {
  const res = await as(token, 'GET', `/workspaces/${ws}/approvals${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Array<Record<string, unknown> & { id: string; unknown: boolean }>;
};

beforeAll(async () => {
  app = await createTestApp();
  const o = await signUpUser(app, 'Mal Owner');
  owner = { token: o.token, id: (await as(o.token, 'GET', '/me')).json().id };
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'Mal WS' })).json().id;
  const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  member = await joinAs(app, owner.token, ws, 'Mal Member', 'member');
  guest = await joinAs(app, owner.token, ws, 'Mal Guest', 'guest', [{ database_id: tasks, role: 'viewer' }]);
  good = await seed({ ctx: { workspaceId: ws, databaseId: tasks, recordId: null, actorId: owner.id }, action: { type: 'send_webhook', url: 'https://example.test/hook' } }, { previewText: 'A good one' });
  for (const [, snapshot] of MALFORMED) malformedIds.push((await seed(snapshot)).id);
  warn = vi.spyOn(Logger.prototype, 'warn'); // from here on: everything this file makes the API say
}, 240_000);
afterAll(async () => {
  warn.mockRestore();
  await app.close();
});

describe('#1298 GET /approvals with unreadable snapshots in the table', () => {
  for (const who of ['owner', 'member'] as const) {
    it(`${who}: 200, the good row is still there and unchanged`, async () => {
      const rows = await list(who === 'owner' ? owner.token : member.token);
      const row = rows.find((r) => r.id === good.id)!;
      expect(row).toBeTruthy();
      expect(row.unknown).toBe(false);
      expect(row.preview_text).toBe('A good one');
      expect((row.action_snapshot as { action: { type: string } }).action.type).toBe('send_webhook');
    });

    it(`${who}: every unreadable row is listed as an unknown request - same shape, nulls, never dropped`, async () => {
      const rows = await list(who === 'owner' ? owner.token : member.token);
      const goodShape = Object.keys(rows.find((r) => r.id === good.id)!).sort();
      for (const id of malformedIds) {
        const row = rows.find((r) => r.id === id);
        expect(row, `row ${id} must not be dropped`).toBeTruthy();
        expect(row!.unknown).toBe(true);
        expect(row!.action_snapshot).toBeNull();
        expect(row!.caused_by).toBeNull();
        expect(row!.preview_text).toBe('Unknown request');
        expect(row!.status).toBe('pending');
        expect(Object.keys(row!).sort()).toEqual(goodShape);
      }
    });
  }

  it('the status filter still works with unreadable rows around', async () => {
    const rows = await list(owner.token, '?status=pending');
    expect(rows.length).toBe(1 + MALFORMED.length);
    expect((await list(owner.token, '?status=approved')).length).toBe(0);
  });

  it('a restricted GUEST: 200, sees the good row, and never an unreadable one (no database to prove they may see it)', async () => {
    const rows = await list(guest.token);
    expect(rows.map((r) => r.id)).toEqual([good.id]);
  });

  it('count agrees with the list for a guest and for the owner', async () => {
    const g = await as(guest.token, 'GET', `/workspaces/${ws}/approvals/count?status=pending`);
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().total).toBe(1);
    const o = await as(owner.token, 'GET', `/workspaces/${ws}/approvals/count?status=pending`);
    expect(o.json().total).toBe(1 + MALFORMED.length);
  });
});

describe('#1298 a row whose database is readable but whose action is not', () => {
  it('a guest on that database sees it as an unknown request, and the list agrees with the count (both read ctx.databaseId alone)', async () => {
    const row = await seed({ type: 'add_comment', ctx: { databaseId: tasks, workspaceId: ws } }); // the shape the #1009 suite seeds: no `action`
    const rows = await list(guest.token);
    expect(rows.map((r) => r.id).sort()).toEqual([good.id, row.id].sort());
    expect(rows.find((r) => r.id === row.id)!.unknown).toBe(true);
    const g = await as(guest.token, 'GET', `/workspaces/${ws}/approvals/count?status=pending`);
    expect(g.json().total).toBe(rows.length);
  });
});

describe('#1298 approve / reject on an unreadable row', () => {
  for (const verb of ['approve', 'reject'] as const) {
    it(`${verb}: a clean 422 that says why, with a stable code - never a 500 - and the row stays pending`, async () => {
      for (const id of malformedIds) {
        const res = await as(owner.token, 'POST', `/workspaces/${ws}/approvals/${id}/${verb}`, verb === 'reject' ? { reason: 'no' } : {});
        expect(res.statusCode, `${verb} ${id}: ${res.body}`).toBe(422);
        expect(res.json().error.code).toBe('approval_unreadable');
        expect(res.json().error.message).toMatch(/could not be read/i);
      }
      const rows = await raw.select().from(approvals).where(eq(approvals.workspaceId, ws));
      for (const id of malformedIds) expect(rows.find((r) => r.id === id)!.status).toBe('pending');
      const jobs = await raw.select().from(automationJobs).where(eq(automationJobs.workspaceId, ws));
      expect(jobs.length).toBe(0);
    });
  }

  it('a non-admin non-approver who cannot see the row gets the ordinary 404, not a 422 that confirms it exists', async () => {
    const row = await seed({ kind: 'send_email' }, { approverId: owner.id });
    const res = await as(guest.token, 'POST', `/workspaces/${ws}/approvals/${row.id}/approve`, {});
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe('#1298 My work (waiting) uses the same reading', () => {
  it('lists unreadable approvals as unknown requests, and the good one as itself', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${ws}/my-work?tab=waiting`);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().approvals.items as Array<{ approval_id: string; preview_text: string; unknown: boolean }>;
    const goodItem = items.find((i) => i.approval_id === good.id)!;
    expect(goodItem).toMatchObject({ preview_text: 'A good one', unknown: false });
    for (const id of malformedIds) {
      expect(items.find((i) => i.approval_id === id), `my-work dropped ${id}`).toMatchObject({ preview_text: 'Unknown request', unknown: true });
    }
  });
});

describe('#1298 the trace', () => {
  it('every unreadable row was logged exactly ONCE across all of the requests above (list x many, count, my-work, approve, reject), with no personal data from the row', () => {
    const lines = warn.mock.calls.map((c) => String(c[0]));
    for (const id of malformedIds) {
      const mine = lines.filter((l) => l.includes(id));
      expect(mine.length, `row ${id} was logged ${mine.length} times`).toBe(1);
      expect(mine[0]).toMatch(/unreadable/i);
    }
    expect(lines.some((l) => l.includes('raw preview from the row'))).toBe(false);
    expect(lines.some((l) => l.includes('example.test'))).toBe(false);
    expect(lines.some((l) => l.includes(good.id))).toBe(false); // a readable row is never logged
  });
});
