import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { FakeSlack } from './helpers/slack-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { env } from '../src/config/env';
import { AccessService } from '../src/access/access.service';
import { SlackApiClient } from '../src/integrations/slack-installations';
import type { SlackInstallationProvider } from '../src/integrations/slack-installations';
import { SlackEventsService, SLACK_EVENTS_PATH } from '../src/integrations/slack-events.service';
import { SlackUnfurlService } from '../src/integrations/slack-unfurl.service';

/**
 * Ticket #1379 - Slack link previews: a StoryOS record link pasted in the Slack workspace that installed us shows the record's
 * TITLE and STATE, and nothing else, and only when the record is open to every member.
 *
 * Everything runs against a MOCKED Slack (test/helpers/slack-fake.ts: a real loopback HTTP server speaking `auth.test` and
 * `chat.unfurl`). Nothing here reaches slack.com, so what this proves is OUR side: signature, who may be previewed, and what is
 * sent. What it cannot prove is that Slack renders the blocks, or that a real app's event subscription is configured; the PR says so.
 *
 * Fixture (workspace A installed Slack team T_A; workspace B installed T_B):
 *   A / space "Team" (open):  db "Tickets" (open, State select)   db "Payroll" (RESTRICTED, inside the open space)
 *   A / space "Back" (RESTRICTED): db "Hiring" (closed by its space)   db "Offers" (RESTRICTED itself, inside it)
 *   B / space "Other": db "Notes" (open)
 */
let app: NestFastifyApplication;
let db: Db;
let fake: FakeSlack;
let events: SlackEventsService;
let owner: { token: string };
let alice: Person; // member holding a grant on the restricted things
let bob: Person; // member with no grant
let dave: Person; // guest with a grant on the open space
let wsA: string, wsB: string;
let teamSpace: string, backSpace: string;
let tickets: string, payroll: string, hiring: string, offers: string, notesB: string;
let stateApi: string;
let todoId: string;

const SECRET = 'a-slack-signing-secret-for-tests';
const TOKEN_A = 'xoxb-test-token-A';
const TOKEN_B = 'xoxb-test-token-B';
const BODY_SECRET = 'BODY-SECRET-do-not-leak';
const PAYROLL_SECRET = 'Payroll: CEO salary 900k';
let eventSeq = 0;
let savedSecret: string | undefined;

const adm = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const dbUrl = (ws: string, id: string) => `/workspaces/${ws}/databases/${id}`;
const link = (ws: string, database: string, rec: string | number) => `${env().WEB_URL}/w/${ws}/d/${database}/r/${rec}`;

function sign(body: string, ts: number | string = Math.floor(Date.now() / 1000), secret = SECRET) {
  return { ts: String(ts), sig: `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}` };
}

async function post(body: string, over: { sig?: string | null; ts?: string | null; retry?: string } = {}) {
  const s = sign(body);
  return app.inject({
    method: 'POST',
    url: SLACK_EVENTS_PATH,
    headers: {
      'content-type': 'application/json',
      ...(over.ts === null ? {} : { 'x-slack-request-timestamp': over.ts ?? s.ts }),
      ...(over.sig === null ? {} : { 'x-slack-signature': over.sig ?? s.sig }),
      ...(over.retry ? { 'x-slack-retry-num': over.retry } : {}),
    },
    payload: body,
  });
}

function linkShared(urls: string[], over: { team?: string; source?: string; eventId?: string; channel?: string } = {}) {
  const composer = over.source === 'composer';
  return JSON.stringify({
    type: 'event_callback',
    team_id: over.team ?? 'T_A',
    event_id: over.eventId ?? `Ev${++eventSeq}`,
    event: {
      type: 'link_shared',
      user: 'U_POSTER',
      channel: over.channel ?? 'C_GENERAL',
      ...(composer ? { unfurl_id: 'Uf123.abc', source: 'composer' } : { message_ts: '1700000000.000100', source: 'conversations_history' }),
      links: urls.map((url) => ({ url, domain: new URL(url).hostname })),
    },
  });
}

/** Deliver a signed link_shared event, wait for the unfurl it started, and return the HTTP answer. */
async function shared(urls: string[], over: Parameters<typeof linkShared>[1] = {}) {
  const res = await post(linkShared(urls, over));
  await events.whenIdle();
  return res;
}

const unfurlCalls = () => fake.of('chat.unfurl');
const unfurledUrls = () => unfurlCalls().flatMap((c) => Object.keys(c.body.unfurls as Record<string, unknown>));

async function mkRecord(ws: string, database: string, values: Record<string, unknown>) {
  const res = await adm('POST', `${dbUrl(ws, database)}/records`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; number: number };
}

beforeAll(async () => {
  savedSecret = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = SECRET;
  fake = new FakeSlack();
  await fake.start();
  fake.tokens.set(TOKEN_A, 'T_A');
  fake.tokens.set(TOKEN_B, 'T_B');

  app = await createTestApp();
  db = app.get(DB);
  events = app.get(SlackEventsService);
  app.get(SlackApiClient).fetcher = fake.fetcher;

  owner = await signUpUser(app, 'SL Owner');
  wsA = (await adm('POST', '/workspaces', { name: 'Slack WS A' })).json().id;
  wsB = (await adm('POST', '/workspaces', { name: 'Slack WS B' })).json().id;
  for (const [ws, token] of [[wsA, TOKEN_A], [wsB, TOKEN_B]] as const) {
    const saved = await adm('POST', `/workspaces/${ws}/integrations/slack`, { bot_token: token });
    expect(saved.statusCode, saved.body).toBe(201);
  }

  teamSpace = (await adm('GET', `/workspaces/${wsA}/spaces`)).json()[0].id;
  backSpace = (await adm('POST', `/workspaces/${wsA}/spaces`, { name: 'Back office' })).json().id;
  const mk = async (ws: string, space: string, name: string) => (await adm('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  tickets = await mk(wsA, teamSpace, 'Tickets');
  payroll = await mk(wsA, teamSpace, 'Payroll');
  hiring = await mk(wsA, backSpace, 'Hiring');
  offers = await mk(wsA, backSpace, 'Offers');
  const spaceB = (await adm('GET', `/workspaces/${wsB}/spaces`)).json()[0].id;
  notesB = await mk(wsB, spaceB, 'Notes');

  const state = (
    await adm('POST', `${dbUrl(wsA, tickets)}/fields`, {
      display_name: 'State',
      type: 'select',
      config: {},
      options: [{ label: 'Todo' }, { label: 'In Progress' }],
    })
  ).json();
  stateApi = state.apiName;
  todoId = state.options.find((o: { label: string }) => o.label === 'Todo').id;
  // A second field that must never appear in a preview, whatever it holds.
  await adm('POST', `${dbUrl(wsA, tickets)}/fields`, { display_name: 'Notes', type: 'text', config: {} });

  alice = await joinAs(app, owner.token, wsA, 'SL Alice', 'member');
  bob = await joinAs(app, owner.token, wsA, 'SL Bob', 'member');
  dave = await joinAs(app, owner.token, wsA, 'SL Dave', 'guest', [{ space_id: teamSpace, role: 'editor' }]);

  await setRestricted(app, owner.token, wsA, 'database', payroll);
  await setRestricted(app, owner.token, wsA, 'space', backSpace);
  await setRestricted(app, owner.token, wsA, 'database', offers);
  // The person who WOULD have access if this were a per-person check: a grant must not turn a preview on.
  await grant(app, owner.token, wsA, alice.id, { database_id: payroll }, 'viewer');
  await grant(app, owner.token, wsA, alice.id, { space_id: backSpace }, 'viewer');
  await grant(app, owner.token, wsA, alice.id, { database_id: offers }, 'viewer');
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  if (savedSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = savedSecret;
});

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  fake.reset();
});

describe('what a preview is (title and state only)', () => {
  it('unfurls an open record by number: its title and state, and NOTHING else it holds', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Ship the Slack previews', [stateApi]: todoId, notes: BODY_SECRET });
    const url = link(wsA, tickets, rec.number);
    const res = await shared([url]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(unfurlCalls()).toHaveLength(1);
    const call = unfurlCalls()[0]!;
    // The wire: Slack's own method, the installing workspace's token, a JSON body aimed at the posted message.
    expect(call.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(call.contentType).toContain('application/json');
    expect(call.body.channel).toBe('C_GENERAL');
    expect(call.body.ts).toBe('1700000000.000100');
    expect(Object.keys(call.body.unfurls as object)).toEqual([url]);

    const wire = JSON.stringify(call.body);
    expect(wire).toContain('Ship the Slack previews');
    expect(wire).toContain('Todo');
    expect(wire).not.toContain(BODY_SECRET);
    // The entire preview is one title block and one state block. A new kind of content has nowhere to arrive.
    const blocks = ((call.body.unfurls as Record<string, { blocks: unknown[] }>)[url]!).blocks;
    expect(blocks).toHaveLength(2);
    expect(JSON.stringify(blocks)).toBe(
      JSON.stringify([
        { type: 'section', text: { type: 'mrkdwn', text: '*Ship the Slack previews*' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'State: *Todo*' }] },
      ]),
    );
  });

  it('unfurls by record uuid too, and a record with no state shows the title alone', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'No state yet' });
    await shared([link(wsA, tickets, rec.id)]);
    expect(unfurlCalls()).toHaveLength(1);
    const blocks = Object.values(unfurlCalls()[0]!.body.unfurls as Record<string, { blocks: unknown[] }>)[0]!.blocks;
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).toContain('No state yet');
  });

  it('shows a title typed with Slack control sequences as literal text: <!channel> pings nobody', async () => {
    const rec = await mkRecord(wsA, tickets, { name: '<!channel> & <https://evil.example|Click here>' });
    await shared([link(wsA, tickets, rec.number)]);
    const wire = JSON.stringify(unfurlCalls()[0]!.body);
    expect(wire).toContain('&lt;!channel&gt; &amp; &lt;https://evil.example|Click here&gt;');
    expect(wire).not.toContain('<!channel>');
    expect(wire).not.toContain('<https://evil');
  });

  it('shows the title a reader WITHOUT access to the record\'s cross-record inputs sees (title_local), never the full computed title', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Full title with a lookup from a closed database: salary 900k' });
    await db.execute(sql`UPDATE records SET title_local = 'Full title with a lookup from a closed database: —' WHERE id = ${rec.id}`);
    await shared([link(wsA, tickets, rec.number)]);
    const wire = JSON.stringify(unfurlCalls()[0]!.body);
    expect(wire).toContain('Full title with a lookup from a closed database: —');
    expect(wire).not.toContain('salary 900k');
  });

  it('keeps a very long title to one bounded line', async () => {
    const rec = await mkRecord(wsA, tickets, { name: `${'long '.repeat(200)}\nsecond line` });
    await shared([link(wsA, tickets, rec.number)]);
    const section = (Object.values(unfurlCalls()[0]!.body.unfurls as Record<string, { blocks: Array<{ text: { text: string } }> }>)[0]!).blocks[0]!;
    expect(section.text.text.length).toBeLessThanOrEqual(160);
    expect(section.text.text).not.toContain('\n');
  });

  it('answers several links in one message with one chat.unfurl, previewing only those that may be shown', async () => {
    const a = await mkRecord(wsA, tickets, { name: 'Open one' });
    const b = await mkRecord(wsA, tickets, { name: 'Open two' });
    const secret = await mkRecord(wsA, payroll, { name: PAYROLL_SECRET });
    await shared([link(wsA, tickets, a.number), link(wsA, payroll, secret.number), link(wsA, tickets, b.id)]);
    expect(unfurlCalls()).toHaveLength(1);
    expect(unfurledUrls().sort()).toEqual([link(wsA, tickets, a.number), link(wsA, tickets, b.id)].sort());
    expect(JSON.stringify(unfurlCalls()[0]!.body)).not.toContain(PAYROLL_SECRET);
  });

  it('answers a composer draft with unfurl_id and source, not a channel', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Composer draft' });
    await shared([link(wsA, tickets, rec.number)], { source: 'composer' });
    expect(unfurlCalls()).toHaveLength(1);
    expect(unfurlCalls()[0]!.body.unfurl_id).toBe('Uf123.abc');
    expect(unfurlCalls()[0]!.body.source).toBe('composer');
    expect(unfurlCalls()[0]!.body.channel).toBeUndefined();
  });
});

describe('who may be previewed: the object decides, not the person who pasted it', () => {
  let openRec: { id: string; number: number };
  let payrollRec: { id: string; number: number };
  let hiringRec: { id: string; number: number };
  let offersRec: { id: string; number: number };

  beforeAll(async () => {
    openRec = await mkRecord(wsA, tickets, { name: 'An open ticket' });
    payrollRec = await mkRecord(wsA, payroll, { name: PAYROLL_SECRET });
    hiringRec = await mkRecord(wsA, hiring, { name: 'Hire a CFO' });
    offersRec = await mkRecord(wsA, offers, { name: 'Offer letter 7' });
  });

  it('control: the open record previews, so every refusal below is the rule and not a broken fixture', async () => {
    await shared([link(wsA, tickets, openRec.number)]);
    expect(unfurledUrls()).toEqual([link(wsA, tickets, openRec.number)]);
  });

  it.each([
    ['a RESTRICTED database inside an open space', () => link(wsA, payroll, payrollRec.number)],
    ['the same, by record uuid', () => link(wsA, payroll, payrollRec.id)],
    ['a database closed by its RESTRICTED SPACE', () => link(wsA, hiring, hiringRec.number)],
    ['a restricted database inside a restricted space (sticky restriction)', () => link(wsA, offers, offersRec.number)],
  ])('previews nothing for %s, although a member holds a grant on it', async (_name, url) => {
    const res = await shared([url()]);
    expect(res.statusCode).toBe(200);
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('previews nothing for a trashed record, by number or by uuid', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Soon trashed' });
    expect((await adm('DELETE', `${dbUrl(wsA, tickets)}/records/${rec.id}`)).statusCode).toBeLessThan(300);
    await shared([link(wsA, tickets, rec.number), link(wsA, tickets, rec.id)]);
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('previews nothing in a deleted database or a deleted space', async () => {
    const space = (await adm('POST', `/workspaces/${wsA}/spaces`, { name: 'Doomed' })).json().id as string;
    const doomed = (await adm('POST', `/workspaces/${wsA}/databases`, { space_id: space, name: 'Doomed db' })).json().id as string;
    const doomedRec = await mkRecord(wsA, doomed, { name: 'In a doomed database' });
    await shared([link(wsA, doomed, doomedRec.number)]);
    expect(unfurlCalls()).toHaveLength(1); // control: it did preview while alive
    fake.reset();
    const gone = await adm('DELETE', `/workspaces/${wsA}/spaces/${space}`, { confirm: 'Doomed' });
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    await shared([link(wsA, doomed, doomedRec.number)]);
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('previews nothing in a database deleted on its own (its space still alive), and nothing in a space deleted on its own (its database still alive)', async () => {
    const lone = (await adm('POST', `/workspaces/${wsA}/databases`, { space_id: teamSpace, name: 'Lone db' })).json() as { id: string };
    const loneRec = await mkRecord(wsA, lone.id, { name: 'Lone record' });
    const url = link(wsA, lone.id, loneRec.number);
    await shared([url]);
    expect(unfurlCalls()).toHaveLength(1); // control
    fake.reset();
    await db.execute(sql`UPDATE databases SET deleted_at = now() WHERE id = ${lone.id}`);
    await shared([url]);
    expect(unfurlCalls()).toHaveLength(0);
    await db.execute(sql`UPDATE databases SET deleted_at = NULL WHERE id = ${lone.id}`);
    await db.execute(sql`UPDATE spaces SET deleted_at = now() WHERE id = ${teamSpace}`);
    try {
      await shared([url]);
      expect(unfurlCalls()).toHaveLength(0);
    } finally {
      await db.execute(sql`UPDATE spaces SET deleted_at = NULL WHERE id = ${teamSpace}`);
    }
    await shared([url]);
    expect(unfurlCalls()).toHaveLength(1); // control: the deleted_at marks, not the fixture, refused it
  });

  it('previews nothing when the space is personal or the database is a system database, even if the data model were bent', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Would preview' });
    const url = link(wsA, tickets, rec.number);
    await db.execute(sql`UPDATE spaces SET personal = true, owner_user_id = 'someone' WHERE id = ${teamSpace}`);
    try {
      await shared([url]);
      expect(unfurlCalls()).toHaveLength(0);
    } finally {
      await db.execute(sql`UPDATE spaces SET personal = false, owner_user_id = NULL WHERE id = ${teamSpace}`);
    }
    await db.execute(sql`UPDATE databases SET is_system = true WHERE id = ${tickets}`);
    try {
      await shared([url]);
      expect(unfurlCalls()).toHaveLength(0);
    } finally {
      await db.execute(sql`UPDATE databases SET is_system = false WHERE id = ${tickets}`);
    }
    await shared([url]);
    expect(unfurlCalls()).toHaveLength(1); // control: the flags, not the fixture, were what refused
  });

  it('is the same silence for a record that does not exist, a database that does not exist, and a malformed link', async () => {
    const answers = [];
    for (const url of [
      link(wsA, tickets, 99999), // no such number
      link(wsA, tickets, '00000000-0000-0000-0000-000000000000'),
      link(wsA, '00000000-0000-0000-0000-000000000000', 1),
      link(wsA, payroll, 99999), // a number that does not exist in a RESTRICTED database
      `${env().WEB_URL}/w/${wsA}/d/${tickets}`,
      `${env().WEB_URL}/w/${wsA}`,
      `${env().WEB_URL}/not/a/record`,
    ]) {
      const res = await shared([url]);
      answers.push([res.statusCode, res.body]);
    }
    expect(unfurlCalls()).toHaveLength(0);
    // And that silence is byte-identical to the answer for a record that is hidden from the preview.
    const hidden = await shared([link(wsA, payroll, payrollRec.number)]);
    for (const a of answers) expect(a).toEqual([hidden.statusCode, hidden.body]);
  });

  it('a record belongs to the database the link NAMES: a restricted record id under an open database id (and the reverse) previews nothing', async () => {
    await shared([link(wsA, tickets, payrollRec.id)]); // hide a restricted record behind an open database's id
    expect(unfurlCalls()).toHaveLength(0);
    await shared([link(wsA, payroll, openRec.id)]);
    expect(unfurlCalls()).toHaveLength(0);
  });
});

describe('which Slack workspace and which StoryOS workspace', () => {
  it('a link into a DIFFERENT StoryOS workspace gets no preview, even from the installing Slack team', async () => {
    const other = await mkRecord(wsB, notesB, { name: 'Workspace B note' });
    await shared([link(wsB, notesB, other.number)]);
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('a link pasted in a Slack workspace nobody installed gets no preview', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Pasted elsewhere' });
    const res = await shared([link(wsA, tickets, rec.number)], { team: 'T_STRANGER' });
    expect(res.statusCode).toBe(200);
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('each Slack team previews only its own StoryOS workspace, and is answered with its own token', async () => {
    const a = await mkRecord(wsA, tickets, { name: 'For team A' });
    const b = await mkRecord(wsB, notesB, { name: 'For team B' });
    await shared([link(wsA, tickets, a.number)], { team: 'T_B' }); // B's Slack, A's link
    expect(unfurlCalls()).toHaveLength(0);
    await shared([link(wsB, notesB, b.number)], { team: 'T_B' });
    expect(unfurlCalls()).toHaveLength(1);
    expect(unfurlCalls()[0]!.authorization).toBe(`Bearer ${TOKEN_B}`);
    expect(JSON.stringify(unfurlCalls()[0]!.body)).not.toContain('For team A');
  });

  it('a link on another host is ignored, and only Slack methods are ever called (no request to any URL from an event)', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Real record' });
    const evil = `https://evil.example.net/w/${wsA}/d/${tickets}/r/${rec.number}`;
    await shared([evil, 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', link(wsA, tickets, rec.number)]);
    expect(unfurledUrls()).toEqual([link(wsA, tickets, rec.number)]);
    for (const c of fake.calls) expect(['auth.test', 'chat.unfurl']).toContain(c.method);
    // Every authorized call carried a workspace's own token and nothing from the event.
    for (const c of fake.calls) expect([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]).toContain(c.authorization);
  });

  it('refuses when two StoryOS workspaces hold a token for the SAME Slack team: nobody can say which one installed it', async () => {
    const wsC = (await adm('POST', '/workspaces', { name: 'Slack WS C' })).json().id as string;
    fake.tokens.set('xoxb-test-token-C', 'T_A');
    await adm('POST', `/workspaces/${wsC}/integrations/slack`, { bot_token: 'xoxb-test-token-C' });
    try {
      const rec = await mkRecord(wsA, tickets, { name: 'Ambiguous team' });
      await shared([link(wsA, tickets, rec.number)]);
      expect(unfurlCalls()).toHaveLength(0);
    } finally {
      await adm('POST', `/workspaces/${wsC}/integrations/slack/disconnect`);
      fake.tokens.delete('xoxb-test-token-C');
    }
    const rec = await mkRecord(wsA, tickets, { name: 'No longer ambiguous' });
    fake.reset();
    await shared([link(wsA, tickets, rec.number)]);
    expect(unfurlCalls()).toHaveLength(1);
  });

  it('stops previewing the moment the workspace disconnects Slack', async () => {
    const wsD = (await adm('POST', '/workspaces', { name: 'Slack WS D' })).json().id as string;
    fake.tokens.set('xoxb-test-token-D', 'T_D');
    await adm('POST', `/workspaces/${wsD}/integrations/slack`, { bot_token: 'xoxb-test-token-D' });
    const spaceD = (await adm('GET', `/workspaces/${wsD}/spaces`)).json()[0].id as string;
    const dbD = (await adm('POST', `/workspaces/${wsD}/databases`, { space_id: spaceD, name: 'D notes' })).json().id as string;
    const rec = await mkRecord(wsD, dbD, { name: 'D note' });
    await shared([link(wsD, dbD, rec.number)], { team: 'T_D' });
    expect(unfurlCalls()).toHaveLength(1);
    fake.reset();
    await adm('POST', `/workspaces/${wsD}/integrations/slack/disconnect`);
    await shared([link(wsD, dbD, rec.number)], { team: 'T_D' });
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('a Slack error is logged and swallowed: the delivery is still a 200 and nothing throws', async () => {
    fake.unfurlError = 'cannot_unfurl_url';
    const rec = await mkRecord(wsA, tickets, { name: 'Slack says no' });
    const res = await shared([link(wsA, tickets, rec.number)]);
    expect(res.statusCode).toBe(200);
    expect(unfurlCalls()).toHaveLength(1);
  });
});

describe('the Events API route', () => {
  it('answers the url_verification handshake with the challenge, but only when it is signed', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P', token: 'x' });
    const ok = await post(body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
    const bad = await post(body, { sig: sign(body, undefined, 'other-secret').sig });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).not.toContain('3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P');
  });

  it('401s every way of not being Slack, with the same answer and no call to anyone', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Unsigned' });
    const body = linkShared([link(wsA, tickets, rec.number)]);
    const stale = sign(body, Math.floor(Date.now() / 1000) - 301);
    const future = sign(body, Math.floor(Date.now() / 1000) + 301);
    const attempts = await Promise.all([
      post(body, { sig: null }),
      post(body, { ts: null }),
      post(body, { sig: sign(body, undefined, 'other-secret').sig }),
      post(body, { sig: 'v0=short' }),
      post(body, { ts: stale.ts, sig: stale.sig }),
      post(body, { ts: future.ts, sig: future.sig }),
    ]);
    // A tampered body: signed over the original bytes, sent altered.
    const tampered = await post(body.replace('C_GENERAL', 'C_OTHER'), { sig: sign(body).sig });
    for (const res of [...attempts, tampered]) {
      expect(res.statusCode).toBe(401);
      // Same answer whatever was wrong (only the per-request id differs).
      const { code, message } = res.json().error;
      expect({ code, message }).toEqual({ code: 'unauthorized', message: 'Unauthorized' });
    }
    await events.whenIdle();
    expect(fake.calls).toHaveLength(0);
  });

  it('FAILS CLOSED with no signing secret: unset, empty and blank all 401, even for a request signed with that very value', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'No secret set' });
    const body = linkShared([link(wsA, tickets, rec.number)]);
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.SLACK_SIGNING_SECRET;
      else process.env.SLACK_SIGNING_SECRET = value;
      const res = await post(body, { sig: sign(body, undefined, value ?? '').sig });
      expect(res.statusCode, JSON.stringify(value)).toBe(401);
    }
    const handshake = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    delete process.env.SLACK_SIGNING_SECRET;
    expect((await post(handshake)).statusCode).toBe(401);
    await events.whenIdle();
    expect(fake.calls).toHaveLength(0);
  });

  it('acknowledges, and does nothing about, every event that is not link_shared and every body it cannot read', async () => {
    const link1 = link(wsA, tickets, (await mkRecord(wsA, tickets, { name: 'Other events' })).number);
    for (const body of [
      JSON.stringify({ type: 'event_callback', team_id: 'T_A', event_id: 'EvX1', event: { type: 'message', text: link1 } }),
      JSON.stringify({ type: 'app_rate_limited', team_id: 'T_A' }),
      JSON.stringify({ type: 'event_callback', team_id: 'T_A', event_id: 'EvX2' }),
      JSON.stringify([1, 2, 3]),
      JSON.stringify(null),
    ]) {
      const res = await post(body);
      expect(res.statusCode, body).toBe(200);
    }
    // A body that is not JSON never reaches the handler: the app's JSON parser answers 400 first. Either way nothing is called.
    for (const body of ['not json at all', '']) expect((await post(body)).statusCode, body).toBeGreaterThanOrEqual(400);
    await events.whenIdle();
    expect(fake.calls).toHaveLength(0);
  });

  it('does not redo an event id it already took (Slack\'s own retries carry the same id): one event, one unfurl', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Retried' });
    const body = linkShared([link(wsA, tickets, rec.number)], { eventId: 'EvRETRY1' });
    expect((await post(body)).statusCode).toBe(200);
    await events.whenIdle();
    expect((await post(body, { retry: '1' })).statusCode).toBe(200);
    expect((await post(body)).statusCode).toBe(200);
    await events.whenIdle();
    expect(unfurlCalls()).toHaveLength(1);
  });

  it('DOES act on a retry of a delivery it never took: a first attempt that failed (here: unsigned) must not cost the preview', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'First attempt failed' });
    const body = linkShared([link(wsA, tickets, rec.number)], { eventId: 'EvRETRY2' });
    expect((await post(body, { sig: null })).statusCode).toBe(401); // the first attempt, refused: nothing was taken
    expect((await post(body, { retry: '1' })).statusCode).toBe(200);
    await events.whenIdle();
    expect(unfurlCalls()).toHaveLength(1);
  });

  it('survives hostile link_shared payloads without a 5xx', async () => {
    const hostile = [
      { type: 'event_callback', team_id: { $ne: 1 }, event_id: 'h1', event: { type: 'link_shared', links: [{ url: 'x' }] } },
      { type: 'event_callback', team_id: 'T_A', event_id: 'h2', event: { type: 'link_shared', links: 'nope' } },
      { type: 'event_callback', team_id: 'T_A', event_id: 'h3', event: { type: 'link_shared', links: [null, 7, { url: 7 }, { url: 'x'.repeat(5000) }] } },
      { type: 'event_callback', team_id: 'T_A', event_id: 'h4', event: { type: 'link_shared', channel: 7, message_ts: {}, links: [{ url: link(wsA, tickets, 1) }] } },
      { type: 'event_callback', team_id: 'T_A', event_id: 'h5', event: { type: 'link_shared', source: 'composer', links: [{ url: link(wsA, tickets, 1) }] } },
    ];
    for (const h of hostile) expect((await post(JSON.stringify(h))).statusCode).toBe(200);
    await events.whenIdle();
    expect(unfurlCalls()).toHaveLength(0);
  });
});

describe('the installation seam (what ticket #1378 swaps)', () => {
  it('SlackUnfurlService asks only the SlackInstallationProvider interface who installed a team and which token to use', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Seam' });
    fake.tokens.set('xoxb-from-another-source', 'T_SEAM');
    const asked: string[] = [];
    const provider: SlackInstallationProvider = {
      findByTeamId: async (teamId) => {
        asked.push(teamId);
        return teamId === 'T_SEAM' ? { workspaceId: wsA, teamId, botToken: 'xoxb-from-another-source' } : null;
      },
    };
    const service = new SlackUnfurlService(db, app.get(AccessService), app.get(SlackApiClient), provider);
    const links = [{ url: link(wsA, tickets, rec.number) }];
    const out = await service.handleLinkShared({ teamId: 'T_SEAM', channel: 'C1', messageTs: '1.1', links });
    expect(out).toEqual({ unfurled: 1 });
    expect(unfurlCalls()[0]!.authorization).toBe('Bearer xoxb-from-another-source');
    // A provider that says "not installed" is the end of it: no auth.test, no token, no unfurl.
    fake.reset();
    expect(await service.handleLinkShared({ teamId: 'T_OTHER', channel: 'C1', messageTs: '1.1', links })).toEqual({ unfurled: 0, skipped: 'no_installation' });
    expect(fake.calls).toHaveLength(0);
    expect(asked).toEqual(['T_SEAM', 'T_OTHER']);
  });

  it('a provider that returns a different workspace than the link names still cannot cross workspaces', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Cross' });
    const provider: SlackInstallationProvider = { findByTeamId: async (teamId) => ({ workspaceId: wsB, teamId, botToken: TOKEN_B }) };
    const service = new SlackUnfurlService(db, app.get(AccessService), app.get(SlackApiClient), provider);
    const out = await service.handleLinkShared({ teamId: 'T_B', channel: 'C1', messageTs: '1.1', links: [{ url: link(wsA, tickets, rec.number) }] });
    expect(out).toEqual({ unfurled: 0, skipped: 'nothing_to_show' });
    expect(unfurlCalls()).toHaveLength(0);
  });
});

describe('a guest and a member without a grant (the third and fourth person)', () => {
  it('the rule does not depend on who they are: Bob (no grant) and Dave (guest) cannot read Payroll, and a link to it previews nothing in either case', async () => {
    const rec = await mkRecord(wsA, payroll, { name: 'Bob must not learn this through Slack' });
    // Their own answer, from the API, is the control: both get a 404 for it.
    expect((await call(app, bob.token, 'GET', `${dbUrl(wsA, payroll)}/records/${rec.id}`)).statusCode).toBe(404);
    expect((await call(app, dave.token, 'GET', `${dbUrl(wsA, payroll)}/records/${rec.id}`)).statusCode).toBe(404);
    // And what the Slack workspace sees is the same nothing, whoever of them pastes it.
    await shared([link(wsA, payroll, rec.number)]);
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('control: in the OPEN space they can read, the preview exists, so the refusal above is the restriction', async () => {
    const rec = await mkRecord(wsA, tickets, { name: 'Everyone can read this' });
    expect((await call(app, bob.token, 'GET', `${dbUrl(wsA, tickets)}/records/${rec.id}`)).statusCode).toBe(200);
    expect((await call(app, dave.token, 'GET', `${dbUrl(wsA, tickets)}/records/${rec.id}`)).statusCode).toBe(200);
    await shared([link(wsA, tickets, rec.number)]);
    expect(unfurlCalls()).toHaveLength(1);
  });
});
