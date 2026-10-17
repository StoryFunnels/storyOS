import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { notifications } from '../src/db/schema';
import { EmailService } from '../src/mail/email.service';
import { SlackService } from '../src/integrations/slack.service';

/**
 * #880 / ADR-0018 phase 2 — a notification is read through the caller's CURRENT access, and the paths that carry its text outside
 * the app (email, Slack) check at SEND time. KEEP AND FILTER (Otto, 2026-10-14): stored rows are never rewritten or purged, so a
 * restored grant brings the old notifications back. Emit-time suppression shipped in #690 (notify-access-check.test.ts).
 *
 * Fixture: db Payroll with a record; bob and alice are members who were mentioned and watch it while it was OPEN; Payroll is then
 * restricted and only alice keeps a grant. dave is a GUEST whose grant is later revoked.
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, general: string, payroll: string, tasks: string, payrollRec: string, tasksRec: string;
let alice: Person, bob: Person, dave: Person;
const SECRET = 'Payroll secret: CEO salary 900k';
const as = (p: { token: string }, method: string, url: string, payload?: unknown) => call(app, p.token, method, url, payload);
const adm = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const dbUrl = (id: string) => `/workspaces/${ws}/databases/${id}`;
const mention = (dbId: string, recId: string, userId: string, text: string) =>
  adm('POST', `${dbUrl(dbId)}/records/${recId}/comments`, { body: [{ type: 'text', text: `${text} ` }, { type: 'mention', user_id: userId }] });
const inbox = async (p: { token: string }) => as(p, 'GET', `/workspaces/${ws}/notifications`);
const unread = async (p: { token: string }) => (await as(p, 'GET', `/workspaces/${ws}/notifications/unread-count`)).json().count as number;

let emailSend: ReturnType<typeof vi.spyOn>;
let slackSend: ReturnType<typeof vi.spyOn>;
const emailedTo = () => emailSend.mock.calls.map((c) => (c[0] as { to: string }).to);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'NA Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Notif Access' })).json().id;
  general = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  payroll = (await adm('POST', '/workspaces/' + ws + '/databases', { space_id: general, name: 'Payroll' })).json().id;
  tasks = (await adm('POST', '/workspaces/' + ws + '/databases', { space_id: general, name: 'Tasks' })).json().id;
  payrollRec = (await adm('POST', `${dbUrl(payroll)}/records`, { values: { name: 'Q3 pay run' } })).json().id;
  tasksRec = (await adm('POST', `${dbUrl(tasks)}/records`, { values: { name: 'Write the launch plan' } })).json().id;
  alice = await joinAs(app, owner.token, ws, 'NA Alice', 'member');
  bob = await joinAs(app, owner.token, ws, 'NA Bob', 'member');
  dave = await joinAs(app, owner.token, ws, 'NA Dave', 'guest', [{ database_id: payroll, role: 'viewer' }]);
  emailSend = vi.spyOn(app.get(EmailService), 'send').mockResolvedValue(undefined as never);
  // prototype, not app.get(): CollaborationModule provides its OWN SlackService instance (#268)
  slackSend = vi.spyOn(SlackService.prototype, 'sendMessage').mockResolvedValue(undefined as never);
  // while Payroll is OPEN: both members are mentioned and both watch the record
  await mention(payroll, payrollRec, bob.id, SECRET);
  await mention(payroll, payrollRec, alice.id, SECRET);
  for (const p of [alice, bob]) await as(p, 'POST', `${dbUrl(payroll)}/records/${payrollRec}/watch`);
  // dave (guest) holds a notification about Payroll too, written straight to the table (a guest cannot be @-mentioned)
  await rawDb.insert(notifications).values({ userId: dave.id, workspaceId: ws, databaseId: payroll, recordId: payrollRec, actorId: null, type: 'commented', snippet: SECRET });
  await setRestricted(app, owner.token, ws, 'database', payroll);
  await grant(app, owner.token, ws, alice.id, { database_id: payroll }, 'viewer');
}, 240_000);
afterAll(async () => { slackSend.mockRestore(); await app.close(); });
beforeEach(() => { emailSend.mockClear(); slackSend.mockClear(); });

describe('#880 read time: the list and the unread count honour CURRENT access', () => {
  it('bob lost the right to see Payroll: no title, snippet, id or database name in the body, and the badge does not count it', async () => {
    const res = await inbox(bob);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Q3 pay run');
    expect(res.body).not.toContain('CEO salary');
    expect(res.body).not.toContain(payrollRec);
    expect(res.body).not.toContain('Payroll');
    expect(res.json().data).toEqual([]);
    expect(await unread(bob), 'the badge must not announce what the list hides').toBe(0);
  });

  it('alice still holds a grant: her notification is there, unchanged, and counted', async () => {
    const res = await inbox(alice);
    expect(res.json().data.length).toBe(1);
    expect(res.json().data[0].record.title).toBe('Q3 pay run');
    expect(await unread(alice)).toBe(1);
  });

  it('the guest whose grant was revoked sees nothing; the admin sees everything', async () => {
    const grants = (await adm('GET', `/workspaces/${ws}/grants?user_id=${dave.id}`)).json().data as Array<{ id: string }>;
    for (const g of grants) await adm('DELETE', `/workspaces/${ws}/grants/${g.id}`);
    const res = await inbox(dave);
    expect(res.body).not.toContain('CEO salary');
    expect(res.json().data).toEqual([]);
    expect(await unread(dave)).toBe(0);
  });

  it('hidden rows are skipped, not just blanked: a visible notification behind 31 hidden ones is still on page one', async () => {
    const hidden = Array.from({ length: 31 }, (_, i) => ({ userId: bob.id, workspaceId: ws, databaseId: payroll, recordId: payrollRec, actorId: null, type: 'commented' as const, snippet: `hidden ${i}`, createdAt: new Date(Date.now() + 1000 + i) }));
    await rawDb.insert(notifications).values(hidden);
    await rawDb.insert(notifications).values({ userId: bob.id, workspaceId: ws, databaseId: tasks, recordId: tasksRec, actorId: null, type: 'commented', snippet: 'visible one', createdAt: new Date(Date.now() - 5000) });
    const res = await inbox(bob);
    expect(res.json().data.map((n: { snippet: string }) => n.snippet)).toEqual(['visible one']);
    expect(res.body).not.toContain('hidden');
    expect(await unread(bob)).toBe(1);
  });

  it('MUST KEEP WORKING: a restored grant brings the old notification back (nothing was purged)', async () => {
    await grant(app, owner.token, ws, bob.id, { database_id: payroll }, 'viewer');
    const res = await inbox(bob);
    expect(res.body).toContain('Q3 pay run');
    expect(res.json().data.length).toBeGreaterThan(1);
    expect(await unread(bob)).toBeGreaterThan(1);
  });
});

describe('#880 delivery paths check access at SEND time', () => {
  let carol: Person;
  beforeAll(async () => { carol = await joinAs(app, owner.token, ws, 'NA Carol', 'member'); });

  it('mention email: a member with no grant on the restricted database is NOT emailed the comment; one with a grant is', async () => {
    await mention(payroll, payrollRec, carol.id, SECRET);
    await mention(payroll, payrollRec, alice.id, SECRET);
    expect(emailedTo()).not.toContain(carol.email);
    expect(emailedTo()).toContain(alice.email);
  });

  it('Slack mirror: a mention on a record of a RESTRICTED database is not posted to the shared channel', async () => {
    await mention(payroll, payrollRec, alice.id, SECRET);
    await vi.waitFor(() => expect(emailedTo()).toContain(alice.email)); // the mention fan-out has run (email precedes the Slack mirror)
    await new Promise((r) => setTimeout(r, 300));
    expect(slackSend, 'the channel has members the restriction excludes').not.toHaveBeenCalled();
  });

  it('MUST KEEP WORKING: a mention on an OPEN database still emails the person and still mirrors to Slack', async () => {
    await mention(tasks, tasksRec, carol.id, 'please look');
    await vi.waitFor(() => expect(emailedTo()).toContain(carol.email));
    await vi.waitFor(() => expect(slackSend).toHaveBeenCalledTimes(1));
  });

  it('watcher email: a watcher who has lost access is not emailed the change; one who kept it is', async () => {
    await setRestricted(app, owner.token, ws, 'database', payroll); // already restricted; bob regained a grant above, so remove it
    const grants = (await adm('GET', `/workspaces/${ws}/grants?user_id=${bob.id}`)).json().data as Array<{ id: string }>;
    for (const g of grants) await adm('DELETE', `/workspaces/${ws}/grants/${g.id}`);
    emailSend.mockClear();
    const res = await adm('PATCH', `${dbUrl(payroll)}/records/${payrollRec}`, { values: { name: 'Q3 pay run (final)' } });
    expect(res.statusCode, res.body).toBe(200);
    await vi.waitFor(() => expect(emailedTo()).toContain(alice.email));
    expect(emailedTo(), 'bob watches it but can no longer read it').not.toContain(bob.email);
  });
});
