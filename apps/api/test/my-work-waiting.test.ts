import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import { approvals, comments, notifications } from '../src/db/schema';

/**
 * Ticket #1250 — My work gains `waiting` (approvals the caller can decide + mentions they have not answered or read) and `assigned_by_me`,
 * drops finished rows server-side, and every total is a SQL count (exact above the 50-row page).
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string; id: string };
let bea: { token: string; id: string };
let cy: { token: string; id: string };
let me: { token: string; id: string };
let guest: { token: string; id: string };
let ws: string, tasks: string, secret: string, assignee: string, state: string;
let opt: Record<string, string> = {};
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const mk = async (name: string, values: Record<string, unknown> = {}, dbId = tasks) =>
  (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name, ...values } })).json().id as string;
const set = (token: string, rec: string, values: Record<string, unknown>) => as(token, 'PATCH', `/workspaces/${ws}/databases/${tasks}/records/${rec}`, { values });
const tab = async (token: string, t: string, extra = '') => {
  const res = await as(token, 'GET', `/workspaces/${ws}/my-work?tab=${t}${extra}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const titles = async (token: string, t: string, extra = '') => {
  const body = await tab(token, t, extra);
  const g = (body.groups as Array<{ database: { id: string }; records: Array<{ title: string }> }>).find((x) => x.database.id === tasks);
  return (g?.records ?? []).map((r) => r.title);
};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = await createTestApp();
  const o = await signUpUser(app, 'W Owner');
  owner = { token: o.token, id: (await as(o.token, 'GET', '/me')).json().id };
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'W WS' })).json().id;
  const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  secret = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Secret' })).json().id;
  assignee = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Assignee', type: 'user' })).json().apiName;
  const st = (
    await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, {
      display_name: 'State',
      type: 'workflow',
      options: [{ label: 'Todo' }, { label: 'In Progress' }, { label: 'Done' }, { label: 'Canceled' }],
    })
  ).json();
  state = st.apiName;
  opt = Object.fromEntries(st.options.map((o: { label: string; id: string }) => [o.label, o.id]));
  bea = await joinAs(app, owner.token, ws, 'W Bea', 'member');
  cy = await joinAs(app, owner.token, ws, 'W Cy', 'member');
  me = await joinAs(app, owner.token, ws, 'W Me', 'member');
  // a guest who can reach Tasks only; Secret is a restricted database they hold no grant on
  guest = await joinAs(app, owner.token, ws, 'W Guest', 'guest', [{ database_id: tasks, role: 'viewer' }]);
  await setRestricted(app, owner.token, ws, 'database', secret);
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('#1250 finished rows never appear (by state category)', () => {
  it('Done and Canceled are dropped from assigned and created; include_finished brings them back', async () => {
    await mk('open todo', { [assignee]: me.id, [state]: opt['Todo'] });
    await mk('open started', { [assignee]: me.id, [state]: opt['In Progress'] });
    await mk('done one', { [assignee]: me.id, [state]: opt['Done'] });
    await mk('canceled one', { [assignee]: me.id, [state]: opt['Canceled'] });
    const open = await titles(me.token, 'assigned');
    expect(open).toContain('open todo');
    expect(open).toContain('open started');
    expect(open).not.toContain('done one');
    expect(open).not.toContain('canceled one');
    const all = await titles(me.token, 'assigned', '&include_finished=true');
    expect(all).toEqual(expect.arrayContaining(['done one', 'canceled one']));
    // created: the owner made all four; the finished two are dropped there too
    const made = await titles(owner.token, 'created');
    expect(made).toContain('open todo');
    expect(made).not.toContain('done one');
    // a record with NO state at all is open and must be KEPT
    await mk('no state', { [assignee]: me.id });
    expect(await titles(me.token, 'assigned')).toContain('no state');
  });
});

describe('#1250 order inside a section: overdue, due this week, in progress, the rest; each by most recently changed', () => {
  it('orders a fresh set of records', async () => {
    const o2 = await signUpUser(app, 'Order Owner');
    const o2id = (await as(o2.token, 'GET', '/me')).json().id;
    const w2 = (await as(o2.token, 'POST', '/workspaces', { name: 'Order WS' })).json().id;
    const sp = (await as(o2.token, 'GET', `/workspaces/${w2}/spaces`)).json()[0].id;
    const d = (await as(o2.token, 'POST', `/workspaces/${w2}/databases`, { space_id: sp, name: 'T' })).json().id;
    const a = (await as(o2.token, 'POST', `/workspaces/${w2}/databases/${d}/fields`, { display_name: 'Assignee', type: 'user' })).json().apiName;
    const du = (await as(o2.token, 'POST', `/workspaces/${w2}/databases/${d}/fields`, { display_name: 'Due date', type: 'date' })).json().apiName;
    const s = (await as(o2.token, 'POST', `/workspaces/${w2}/databases/${d}/fields`, { display_name: 'State', type: 'workflow', options: [{ label: 'Todo' }, { label: 'In Progress' }, { label: 'Done' }] })).json();
    const o = Object.fromEntries(s.options.map((x: { label: string; id: string }) => [x.label, x.id]));
    const rec = (name: string, v: Record<string, unknown>) => as(o2.token, 'POST', `/workspaces/${w2}/databases/${d}/records`, { values: { name, [a]: o2id, ...v } });
    await rec('other-1', { [s.apiName]: o['Todo'] });
    await rec('started-1', { [s.apiName]: o['In Progress'] });
    await rec('soon-1', { [du]: day(3), [s.apiName]: o['Todo'] });
    await rec('late-1', { [du]: day(-2), [s.apiName]: o['Todo'] });
    await rec('other-2', { [s.apiName]: o['Todo'] }); // newest of the rest
    const res = await as(o2.token, 'GET', `/workspaces/${w2}/my-work?tab=assigned`);
    const rows = (res.json().groups[0].records as Array<{ title: string }>).map((r) => r.title);
    expect(rows).toEqual(['late-1', 'soon-1', 'started-1', 'other-2', 'other-1']);
  });
});

describe('#1250 totals are exact above the 50-row page', () => {
  it('55 open rows: 50 returned, total 55, truncated true; a finished one is not counted', async () => {
    const o3 = await signUpUser(app, 'Big Owner');
    const o3id = (await as(o3.token, 'GET', '/me')).json().id;
    const w3 = (await as(o3.token, 'POST', '/workspaces', { name: 'Big WS' })).json().id;
    const sp = (await as(o3.token, 'GET', `/workspaces/${w3}/spaces`)).json()[0].id;
    const d = (await as(o3.token, 'POST', `/workspaces/${w3}/databases`, { space_id: sp, name: 'Big' })).json().id;
    const a = (await as(o3.token, 'POST', `/workspaces/${w3}/databases/${d}/fields`, { display_name: 'Assignee', type: 'user' })).json().apiName;
    const s = (await as(o3.token, 'POST', `/workspaces/${w3}/databases/${d}/fields`, { display_name: 'State', type: 'workflow', options: [{ label: 'Todo' }, { label: 'Done' }] })).json();
    const o = Object.fromEntries(s.options.map((x: { label: string; id: string }) => [x.label, x.id]));
    const mkBig = (i: number, st: string) => as(o3.token, 'POST', `/workspaces/${w3}/databases/${d}/records`, { values: { name: `big ${i}`, [a]: o3id, [s.apiName]: o[st] } });
    for (let i = 0; i < 55; i += 5) await Promise.all([0, 1, 2, 3, 4].map((k) => mkBig(i + k, 'Todo')));
    await mkBig(99, 'Done');
    const body = (await as(o3.token, 'GET', `/workspaces/${w3}/my-work?tab=assigned`)).json();
    expect(body.groups[0].records).toHaveLength(50);
    expect(body.groups[0].total).toBe(55);
    expect(body.groups[0].truncated).toBe(true);
    expect(body.total).toBe(55);
    expect(body.truncated).toBe(true);
    // under the page, nothing is truncated and total equals what came back
    const small = await tab(me.token, 'assigned');
    expect(small.truncated).toBe(false);
    expect(small.groups[0].total).toBe(small.groups[0].records.length);
  });
});

describe('#1250 assigned_by_me', () => {
  it('open records whose current assignee I set to someone else; ends when anyone else changes it, or it is finished', async () => {
    const r1 = await mk('abm one');
    await set(owner.token, r1, { [assignee]: bea.id });
    const r2 = await mk('abm two');
    await set(owner.token, r2, { [assignee]: bea.id });
    await set(cy.token, r2, { [assignee]: me.id }); // a different person reassigned it: no longer mine to chase
    const r3 = await mk('abm self');
    await set(owner.token, r3, { [assignee]: owner.id }); // I set it to MYSELF: not "to someone else"
    const r4 = await mk('abm done', { [state]: opt['Done'] });
    await set(owner.token, r4, { [assignee]: bea.id });
    const r5 = await mk('abm created with');
    expect(r5).toBeTruthy(); // created, never assigned: no change by me exists
    const mine = await titles(owner.token, 'assigned_by_me');
    expect(mine).toContain('abm one');
    expect(mine).not.toContain('abm two');
    expect(mine).not.toContain('abm self');
    expect(mine).not.toContain('abm done');
    expect(mine).not.toContain('abm created with');
    // the person it was assigned TO, and an uninvolved member, get nothing from this section
    expect(await titles(bea.token, 'assigned_by_me')).not.toContain('abm one');
    expect(await titles(cy.token, 'assigned_by_me')).toEqual(expect.not.arrayContaining(['abm one']));
    const body = await tab(owner.token, 'assigned_by_me');
    const row = body.groups.find((g: { database: { id: string } }) => g.database.id === tasks).records.find((x: { title: string }) => x.title === 'abm one');
    expect(row.assigned_at).toBeTruthy();
    expect(body.groups.find((g: { database: { id: string } }) => g.database.id === tasks).total).toBe(1);
  });

  it('access: a guest with no grant on the database sees none of it', async () => {
    const g = await tab(guest.token, 'assigned_by_me');
    expect(g.groups.every((x: { database: { id: string } }) => x.database.id !== secret)).toBe(true);
  });
});

describe('#1250 waiting', () => {
  const approval = async (databaseId: string, approverId: string | null, over: Record<string, unknown> = {}) =>
    (
      await raw
        .insert(approvals)
        .values({
          workspaceId: ws,
          actionIndex: 0,
          actionSnapshot: { ctx: { databaseId }, action: { type: 'send_webhook' } },
          previewText: 'Send the thing',
          approverId,
          ...over,
        } as never)
        .returning()
    )[0]!;
  const mention = async (recordId: string, authorId: string, mentioned: string[], at = new Date()) =>
    (
      await raw
        .insert(comments)
        .values({ recordId, authorId, body: [{ type: 'text', text: 'ping' }, ...mentioned.map((id) => ({ type: 'mention', user_id: id }))], mentions: mentioned, createdAt: at, updatedAt: at } as never)
        .returning()
    )[0]!;

  it('approvals: the named approver and admins get pending, unexpired ones; nobody else', async () => {
    const mine = await approval(tasks, me.id);
    await approval(tasks, me.id, { status: 'approved' }); // decided
    await approval(tasks, me.id, { expiresAt: new Date(Date.now() - 1000) }); // expired
    await approval(tasks, bea.id); // someone else's
    const w = await tab(me.token, 'waiting');
    expect(w.approvals.items.map((a: { approval_id: string }) => a.approval_id)).toEqual([mine.id]);
    expect(w.approvals.total).toBe(1);
    const bw = await tab(bea.token, 'waiting');
    expect(bw.approvals.items.map((a: { approval_id: string }) => a.approval_id)).not.toContain(mine.id);
    const admin = await tab(owner.token, 'waiting'); // admins can decide every pending approval
    expect(admin.approvals.items.map((a: { approval_id: string }) => a.approval_id)).toContain(mine.id);
    expect(admin.approvals.total).toBeGreaterThanOrEqual(2);
  });

  it('approvals: a guest approver on a database they cannot reach still sees it, but without the record', async () => {
    const rec = await mk('secret record', {}, secret);
    const a = await approval(secret, guest.id, { recordId: rec });
    const w = await tab(guest.token, 'waiting');
    const item = w.approvals.items.find((x: { approval_id: string }) => x.approval_id === a.id);
    expect(item, 'the named approver can decide it').toBeTruthy();
    expect(item.record, 'but the record behind it is not theirs to see').toBeNull();
  });

  it('mentions: unanswered and unread ones list; a reply, or a read mention notification, clears them', async () => {
    const r1 = await mk('m unanswered');
    const r2 = await mk('m replied');
    const r3 = await mk('m read');
    const r4 = await mk('m own comment');
    await mention(r1, owner.id, [me.id]);
    await mention(r2, owner.id, [me.id, ]);
    await as(me.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records/${r2}/comments`, { body: [{ type: 'text', text: 'on it' }] });
    await mention(r3, owner.id, [me.id]);
    await raw.insert(notifications).values({ userId: me.id, workspaceId: ws, recordId: r3, type: 'mentioned', readAt: new Date(Date.now() + 1000), createdAt: new Date(Date.now() + 500) } as never);
    await mention(r4, me.id, [me.id]); // I mentioned myself: never waiting on me
    const w = await tab(me.token, 'waiting');
    const ids = w.mentions.items.map((m: { record: { id: string } }) => m.record.id);
    expect(ids).toContain(r1);
    expect(ids).not.toContain(r2);
    expect(ids).not.toContain(r3);
    expect(ids).not.toContain(r4);
    const item = w.mentions.items.find((m: { record: { id: string } }) => m.record.id === r1);
    expect(item.mentioned_by.id).toBe(owner.id);
    expect(item.excerpt).toContain('ping');
    // another member is not waiting on it
    expect((await tab(cy.token, 'waiting')).mentions.items.map((m: { record: { id: string } }) => m.record.id)).not.toContain(r1);
  });

  it('mentions: a record the caller cannot see never surfaces (guest, restricted database)', async () => {
    const rec = await mk('hidden mention', {}, secret);
    await mention(rec, owner.id, [guest.id]);
    const open = await mk('visible mention');
    await mention(open, owner.id, [guest.id]);
    const w = await tab(guest.token, 'waiting');
    const ids = w.mentions.items.map((m: { record: { id: string } }) => m.record.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(rec);
  });

  it('totals are exact above 50 and say so', async () => {
    const o4 = await signUpUser(app, 'Wait Owner');
    const w4 = (await as(o4.token, 'POST', '/workspaces', { name: 'Wait WS' })).json().id;
    const sp = (await as(o4.token, 'GET', `/workspaces/${w4}/spaces`)).json()[0].id;
    const d = (await as(o4.token, 'POST', `/workspaces/${w4}/databases`, { space_id: sp, name: 'D' })).json().id;
    const ownerId = (await as(o4.token, 'GET', '/me')).json().id;
    for (let i = 0; i < 53; i++) {
      await raw.insert(approvals).values({ workspaceId: w4, actionIndex: 0, actionSnapshot: { ctx: { databaseId: d }, action: { type: 'x' } }, previewText: `p${i}`, approverId: ownerId } as never);
    }
    const w = (await as(o4.token, 'GET', `/workspaces/${w4}/my-work?tab=waiting`)).json();
    expect(w.approvals.items).toHaveLength(50);
    expect(w.approvals.total).toBe(53);
    expect(w.approvals.truncated).toBe(true);
    expect(w.total).toBe(53);
    expect(w.truncated).toBe(true);
  });
});
