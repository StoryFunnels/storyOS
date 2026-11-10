import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { DB } from '../src/db/db.module';
import { myWorkDigestSends } from '../src/db/schema';
import { EmailService } from '../src/mail/email.service';
import { MyWorkService } from '../src/search/my-work.service';
import { MyWorkDigestService } from '../src/my-work-digest/my-work-digest.service';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../src/my-work-digest/digest-token';
import type { MailMessage } from '../src/mail/mail-driver';

/**
 * #1251 — the My work digest send. Every test owns its data and drives `sweep(now, { userIds })` with a FIXED clock restricted to the
 * people it created, so rows other tests left in the shared database can neither send here nor be sent by this file. Mail goes to a
 * capturing driver: nothing is ever delivered.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let svc: MyWorkDigestService;
let owner: { token: string; id: string };
let me: { token: string; id: string };
let empty: { token: string; id: string };
let ws: string, tasks: string, ownerField: string;
const sent: MailMessage[] = [];
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const prefs = (token: string, myWorkEmail: Record<string, unknown>) => as(token, 'PATCH', '/users/me/preferences', { myWorkEmail });
const at = (iso: string) => new Date(iso);
const sweep = async (who: { id: string }, iso: string) => {
  const before = sent.length;
  const n = await svc.sweep(at(iso), { userIds: [who.id] });
  expect(sent.length - before, 'the return value and the mail actually captured agree').toBe(n);
  return n;
};

beforeAll(async () => {
  app = await createTestApp();
  app.get(EmailService).driver = { name: 'capture', send: async (m) => void sent.push(m) };
  svc = new MyWorkDigestService(app.get(DB), app.get(EmailService), app.get(MyWorkService));
  const o = await signUpUser(app, 'DG Owner');
  owner = { token: o.token, id: (await as(o.token, 'GET', '/me')).json().id };
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'DG WS' })).json().id;
  const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  ownerField = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Owner', type: 'user' })).json().apiName;
  me = await joinAs(app, owner.token, ws, 'DG Me', 'member');
  empty = await joinAs(app, owner.token, ws, 'DG Empty', 'member');
  // 17 open records assigned to me (15 shown, "and 2 more"), assigned by the owner so one of them also appears under "You assigned to others"
  // for the OWNER's own digest.
  for (let i = 1; i <= 17; i++) {
    const rec = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: `Digest task ${i}` } })).json().id as string;
    await as(owner.token, 'PATCH', `/workspaces/${ws}/databases/${tasks}/records/${rec}`, { values: { [ownerField]: me.id } });
  }
}, 300_000);
afterAll(async () => { await app.close(); });

describe('#1251 preference', () => {
  it('defaults to off, and rejects a time zone that is not an IANA zone and a malformed time', async () => {
    const got = (await as(me.token, 'GET', '/users/me/preferences')).json();
    expect(got.myWorkEmail).toEqual({ frequency: 'off', weekday: 1, time: '09:00', timezone: null, include_assigned_by_me: false });
    expect((await prefs(me.token, { timezone: 'Mars/Olympus' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await prefs(me.token, { time: '25:00' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await prefs(me.token, { frequency: 'hourly' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await as(me.token, 'GET', '/users/me/preferences')).json().myWorkEmail.frequency).toBe('off');
  });

  it('off sends nothing, however many sweeps', async () => {
    expect(await sweep(me, '2026-11-09T07:00:00Z')).toBe(0);
  });
});

describe('#1251 AC1: the right local time, Mon–Fri for daily, and never twice', () => {
  it('daily 08:00 Europe/Madrid (07:00Z in November): sends at the slot, once, never on a weekend, never late', async () => {
    expect((await prefs(me.token, { frequency: 'daily', time: '08:00', timezone: 'Europe/Madrid' })).statusCode).toBe(200);
    expect(await sweep(me, '2026-11-09T06:59:00Z'), 'Monday, one minute before 08:00 local').toBe(0);
    expect(await sweep(me, '2026-11-09T07:00:00Z'), 'Monday 08:00 local').toBe(1);
    expect(await sweep(me, '2026-11-09T07:00:00Z'), 'the same slot again').toBe(0);
    expect(await sweep(me, '2026-11-09T07:20:00Z'), 'a later sweep inside the same slot window').toBe(0);
    expect(await sweep(me, '2026-11-10T07:00:00Z'), 'Tuesday').toBe(1);
    expect(await sweep(me, '2026-11-13T07:00:00Z'), 'Friday').toBe(1);
    expect(await sweep(me, '2026-11-14T07:00:00Z'), 'Saturday: no digest').toBe(0);
    expect(await sweep(me, '2026-11-15T07:00:00Z'), 'Sunday: no digest').toBe(0);
    expect(await sweep(me, '2026-11-16T07:45:00Z'), 'Monday but 45 minutes late: the slot is missed, not mailed hours after').toBe(0);
    expect(await sweep(me, '2026-11-16T07:10:00Z'), 'Monday inside the catch-up window').toBe(1);
  });

  it('the person is read in THEIR zone, not the server\'s: 08:00 in Madrid is not 08:00 UTC', async () => {
    expect(await sweep(me, '2026-11-17T08:00:00Z'), '09:00 in Madrid, an hour after the slot').toBe(0);
  });

  it('weekly on Wednesday 18:30 America/New_York (23:30Z in November): only that day, once', async () => {
    expect((await prefs(me.token, { frequency: 'weekly', weekday: 3, time: '18:30', timezone: 'America/New_York' })).statusCode).toBe(200);
    expect(await sweep(me, '2026-11-17T23:30:00Z'), 'Tuesday at that time').toBe(0);
    expect(await sweep(me, '2026-11-18T23:29:00Z'), 'Wednesday one minute early').toBe(0);
    expect(await sweep(me, '2026-11-18T23:30:00Z'), 'Wednesday 18:30 local').toBe(1);
    expect(await sweep(me, '2026-11-18T23:30:00Z'), 'again').toBe(0);
    expect(await sweep(me, '2026-11-19T23:30:00Z'), 'Thursday').toBe(0);
    expect(await sweep(me, '2026-11-25T23:30:00Z'), 'the next Wednesday').toBe(1);
  });

  it('two sweeps at once (two API instances) and a fresh service instance (a restart) claim a slot exactly once', async () => {
    expect((await prefs(me.token, { frequency: 'daily', time: '08:00', timezone: 'Europe/Madrid' })).statusCode).toBe(200);
    const restarted = new MyWorkDigestService(app.get(DB), app.get(EmailService), app.get(MyWorkService));
    const before = sent.length;
    const counts = await Promise.all([
      svc.sweep(at('2026-11-30T07:00:00Z'), { userIds: [me.id] }),
      restarted.sweep(at('2026-11-30T07:00:00Z'), { userIds: [me.id] }),
      svc.sweep(at('2026-11-30T07:00:00Z'), { userIds: [me.id] }),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sent.length - before).toBe(1);
    expect(await restarted.sweep(at('2026-11-30T07:05:00Z'), { userIds: [me.id] }), 'a later sweep by the restarted service').toBe(0);
  });
});

describe('#1251 the email', () => {
  it('subject carries the open count; 15 rows then "and 2 more"; List-Unsubscribe is a signed one-click link', async () => {
    const mail = sent.filter((m) => m.subject.startsWith('Your work in DG WS')).at(-1)!;
    expect(mail.subject).toBe('Your work in DG WS: 17 open');
    expect(mail.html).toContain('Assigned to you');
    expect(mail.html).not.toContain('Waiting on you');
    expect(mail.html).not.toContain('You assigned to others');
    expect(mail.html.match(/Digest task \d+/g)!.length).toBe(15);
    expect(mail.html).toContain('and 2 more');
    expect(mail.html).toContain(`/w/${ws}/me`);
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const url = mail.headers!['List-Unsubscribe']!.slice(1, -1);
    expect(url).toContain('/api/v1/public/my-work-digest/unsubscribe?token=');
    expect(mail.html).toContain('Stop these emails');
    expect(mail.html).toContain('Customize these emails');
    expect(mail.html).not.toMatch(/\bAI\b/);
  });

  it('"You assigned to others" is dropped unless the person asked for it, and then follows the others in order', async () => {
    // The owner assigned 17 records to me, so for the OWNER they are "assigned by me".
    expect((await prefs(owner.token, { frequency: 'daily', time: '08:00', timezone: 'Europe/Madrid', include_assigned_by_me: false })).statusCode).toBe(200);
    expect(await sweep(owner, '2026-12-01T07:00:00Z'), 'nothing assigned to the owner and the section is off: nothing to say').toBe(0);
    expect((await prefs(owner.token, { include_assigned_by_me: true })).statusCode).toBe(200);
    expect(await sweep(owner, '2026-12-02T07:00:00Z')).toBe(1);
    const mail = sent.at(-1)!;
    expect(mail.html).toContain('You assigned to others');
    expect(mail.html).not.toContain('Assigned to you ');
    expect(mail.subject).toContain('17 you assigned still open');
  });
});

describe('#1251 AC2: all empty sends nothing', () => {
  it('a person with nothing waiting, assigned or assigned-by-them gets no email, and the slot is still recorded as empty', async () => {
    expect((await prefs(empty.token, { frequency: 'daily', time: '08:00', timezone: 'Europe/Madrid', include_assigned_by_me: true })).statusCode).toBe(200);
    expect(await sweep(empty, '2026-12-03T07:00:00Z')).toBe(0);
    const rows = await raw.select().from(myWorkDigestSends).where(eq(myWorkDigestSends.userId, empty.id));
    expect(rows.map((r) => r.outcome)).toEqual(['empty']);
    expect(await sweep(empty, '2026-12-03T07:01:00Z'), 'and it is not recomputed within the same slot').toBe(0);
  });
});

describe('#1251 AC3: the unsubscribe link turns it off without signing in', () => {
  it('GET with the signed token and NO credentials turns the digest off and lands on Settings › Notifications', async () => {
    expect((await prefs(me.token, { frequency: 'daily', time: '08:00', timezone: 'Europe/Madrid' })).statusCode).toBe(200);
    const token = signUnsubscribeToken(me.id);
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/my-work-digest/unsubscribe?token=${encodeURIComponent(token)}&ws=${ws}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`/w/${ws}/settings/notifications?my_work=off`);
    expect((await as(me.token, 'GET', '/users/me/preferences')).json().myWorkEmail.frequency).toBe('off');
    expect(await sweep(me, '2026-12-07T07:00:00Z'), 'and nothing is sent after it').toBe(0);
  });

  it('keeps the rest of the preference (the time and zone), so switching it back on is one click', async () => {
    const got = (await as(me.token, 'GET', '/users/me/preferences')).json().myWorkEmail;
    expect(got).toMatchObject({ frequency: 'off', time: '08:00', timezone: 'Europe/Madrid' });
  });

  it('the RFC 8058 one-click POST works the same, with no credentials', async () => {
    expect((await prefs(me.token, { frequency: 'weekly' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: `/api/v1/public/my-work-digest/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(me.id))}` });
    expect(res.statusCode).toBe(200);
    expect((await as(me.token, 'GET', '/users/me/preferences')).json().myWorkEmail.frequency).toBe('off');
  });

  it('a token that was not signed by this server turns nothing off: tampered, re-pointed at someone else, empty, or a bare user id', async () => {
    expect((await prefs(me.token, { frequency: 'daily' })).statusCode).toBe(200);
    expect((await prefs(empty.token, { frequency: 'daily' })).statusCode).toBe(200);
    const good = signUnsubscribeToken(me.id);
    const [, sig] = good.split('.');
    const repointed = `${Buffer.from(empty.id).toString('base64url')}.${sig}`; // my signature on someone else's id
    for (const bad of [good.slice(0, -2) + 'xx', repointed, '', me.id, `${Buffer.from(me.id).toString('base64url')}.`, 'a.b.c']) {
      const get = await app.inject({ method: 'GET', url: `/api/v1/public/my-work-digest/unsubscribe?token=${encodeURIComponent(bad)}` });
      expect(get.statusCode, `GET ${bad}`).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/v1/public/my-work-digest/unsubscribe?token=${encodeURIComponent(bad)}` })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/public/my-work-digest/unsubscribe' })).statusCode).toBe(404);
    expect((await as(me.token, 'GET', '/users/me/preferences')).json().myWorkEmail.frequency).toBe('daily');
    expect((await as(empty.token, 'GET', '/users/me/preferences')).json().myWorkEmail.frequency).toBe('daily');
    expect(verifyUnsubscribeToken(good)).toBe(me.id);
  });
});

/**
 * #1251 — ACCESS. A digest is mail: once sent it cannot be taken back, so what it NAMES and COUNTS must be exactly what the recipient can
 * open, computed for the RECIPIENT's membership. Only a guest (a grant on one database) and a member facing a restricted database can
 * have partial access, so this block carries both; a fixture of owners proves nothing. Each case has a control (what they CAN open must
 * appear), so the tests fail when the filter is dropped in either direction: an escalation leaks the hidden titles, an over-eager filter
 * loses the control rows. (Personal-space content is not reachable here: personal space holds documents and views, never records, and
 * the mention-in-personal-content case lives in my-work-waiting.test.ts.)
 */
describe('#1251 access: the digest names and counts only what the recipient can open', () => {
  let guest: { token: string; id: string };
  let limited: { token: string; id: string };
  let openDb: string, vault: string, noGrant: string, revocable: string;
  let revocableGrant: string;
  const field: Record<string, string> = {};
  const mkDb = async (name: string, restricted = false) => {
    const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const id = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
    field[id] = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: 'Owner', type: 'user' })).json().apiName;
    if (restricted) await as(owner.token, 'PATCH', `/workspaces/${ws}/databases/${id}`, { restricted: true });
    return id;
  };
  const give = async (db: string, title: string, to: string) => {
    const rec = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: title } })).json().id as string;
    const res = await as(owner.token, 'PATCH', `/workspaces/${ws}/databases/${db}/records/${rec}`, { values: { [field[db]!]: to } });
    expect(res.statusCode, `assign ${title}`).toBe(200);
  };
  const digestFor = async (who: { id: string; token: string }, iso: string) => {
    expect((await prefs(who.token, { frequency: 'daily', time: '08:00', timezone: 'Europe/Madrid' })).statusCode).toBe(200);
    const before = sent.length;
    await sweep(who, iso);
    expect(sent.length - before, `a digest was sent for ${iso}`).toBe(1);
    return sent.at(-1)!;
  };

  beforeAll(async () => {
    openDb = await mkDb('DGOpenRoom');
    vault = await mkDb('DGVault', true);
    noGrant = await mkDb('DGNoGrantRoom');
    revocable = await mkDb('DGRevocable');
    guest = await joinAs(app, owner.token, ws, 'DG Guest', 'guest', [{ database_id: openDb, role: 'viewer' }, { database_id: revocable, role: 'viewer' }]);
    limited = await joinAs(app, owner.token, ws, 'DG Limited', 'member');
    const grants = (await as(owner.token, 'GET', `/workspaces/${ws}/grants?user_id=${guest.id}`)).json().data as Array<{ id: string; database_id: string | null }>;
    revocableGrant = grants.find((g) => g.database_id === revocable)!.id;
    // The guest: 2 in the database they hold a grant on, 1 in a second granted database, 3 in a RESTRICTED one, 2 in one they have no grant on.
    await give(openDb, 'DGG open 1', guest.id);
    await give(openDb, 'DGG open 2', guest.id);
    await give(revocable, 'DGG revocable 1', guest.id);
    for (const i of [1, 2, 3]) await give(vault, `DGG vault ${i}`, guest.id);
    for (const i of [1, 2]) await give(noGrant, `DGG nogrant ${i}`, guest.id);
    // The member: 1 in an open database, 2 in the restricted one they hold no grant on.
    await give(openDb, 'DGL open 1', limited.id);
    for (const i of [1, 2]) await give(vault, `DGL vault ${i}`, limited.id);
  }, 120_000);

  it('a GUEST with a grant on one database: "N open" counts only the databases they can open, and no title or name from any other appears', async () => {
    const mail = await digestFor(guest, '2027-01-05T07:00:00Z');
    expect(mail.subject, 'the count is of what the guest can open: 2 + 1, never 8').toBe('Your work in DG WS: 3 open');
    // the control: what they CAN open is in the email
    for (const t of ['DGG open 1', 'DGG open 2', 'DGG revocable 1']) expect(mail.html, t).toContain(t);
    // everything they cannot open: not in the html, not in the plain-text part, not as a database name, not in the subject
    for (const leak of ['DGG vault', 'DGG nogrant', 'DGVault', 'DGNoGrantRoom', 'DGL ']) {
      expect(mail.html, `html leaks ${leak}`).not.toContain(leak);
      expect(mail.text ?? '', `text leaks ${leak}`).not.toContain(leak);
      expect(mail.subject).not.toContain(leak);
    }
  });

  it('a MEMBER facing a restricted database: counts and names only the open one, never the restricted records assigned to them', async () => {
    const mail = await digestFor(limited, '2027-01-05T07:00:00Z');
    expect(mail.subject, '1 open, never 3').toBe('Your work in DG WS: 1 open');
    expect(mail.html).toContain('DGL open 1');
    for (const leak of ['DGL vault', 'DGVault', 'DGG ']) {
      expect(mail.html, `html leaks ${leak}`).not.toContain(leak);
      expect(mail.text ?? '').not.toContain(leak);
    }
  });

  it('a record the guest LOSES access to drops out of the next digest, and the control rows stay', async () => {
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/grants/${revocableGrant}`)).statusCode).toBeLessThan(300);
    const mail = await digestFor(guest, '2027-01-06T07:00:00Z');
    expect(mail.subject).toBe('Your work in DG WS: 2 open');
    expect(mail.html).not.toContain('DGG revocable');
    expect(mail.html).not.toContain('DGRevocable');
    expect(mail.html).toContain('DGG open 1');
    expect(mail.html).toContain('DGG open 2');
  });

  it('a guest whose only assignments are in databases they cannot open gets NO email (nothing to say), not an empty-looking one', async () => {
    const stranger = await joinAs(app, owner.token, ws, 'DG Stranger', 'guest', [{ database_id: openDb, role: 'viewer' }]);
    await give(vault, 'DGS vault 1', stranger.id);
    await give(noGrant, 'DGS nogrant 1', stranger.id);
    expect((await prefs(stranger.token, { frequency: 'daily', time: '08:00', timezone: 'Europe/Madrid' })).statusCode).toBe(200);
    expect(await sweep(stranger, '2027-01-07T07:00:00Z')).toBe(0);
    const rows = await raw.select().from(myWorkDigestSends).where(eq(myWorkDigestSends.userId, stranger.id));
    expect(rows.map((r) => r.outcome)).toEqual(['empty']);
  });
});
