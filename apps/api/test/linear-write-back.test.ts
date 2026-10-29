import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { LinearService } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';
import { LinearWriteBackService, COMMENT_CREATE_MUTATION } from '../src/integrations/linear-write-back.service';

/**
 * #907 — a comment added in StoryOS on a mirrored ticket appears on the Linear ticket, signed, exactly once.
 * COMMENTS ONLY; the key stays server-side; no echo on the next sync; an imported comment is never pushed back.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-w', key: 'WB', name: 'WriteBack' };
const KEY = 'lin_api_SECRET_write_back_test_key';
const linearComment = (id: string, body: string, issueId = 'iss-0') => ({
  id, body, createdAt: '2026-09-14T10:00:00.000Z', url: `https://linear.app/acme/issue/WB-1#comment-${id}`, user: { name: 'Tyron Dizon' }, botActor: null, externalUser: null, issue: { id: issueId },
});

let app: NestFastifyApplication;
let linear: LinearService;
let wb: LinearWriteBackService;
let admin: { token: string };
let ws: string;
let dbId: string;
let recId: string;
let issueUuid: string;
const sent: Array<{ query: string; vars: Record<string, unknown> }> = [];
let pushedAsLinearComments: Array<Record<string, unknown>> = [];
let failPushes = false;
let failLookups = false;
let loseResponseOnce = false;
const issueCommentReads: string[] = [];
let counter = 0;

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

/** A Linear that records every call, accepts commentCreate, and (optionally) serves pushed comments back in the stream. */
function installLinear(opts: { echo?: 'as-pushed' | 'edited-body' | 'none'; unknownIdWithSignature?: boolean } = {}) {
  const base = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(1) }, comments: [linearComment('lc-original', 'A human comment in Linear'), ...pushedAsLinearComments] } }]).fetcher;
  const f: LinearFetcher = async (query, variables, apiKey) => {
    if (query.includes('mutation')) {
      sent.push({ query, vars: variables });
      if (failPushes) throw new Error('Linear API 500 — boom');
      if (loseResponseOnce) {
        // #1102 — Linear STORES the comment, then the answer never reaches us (timeout / dropped connection)
        loseResponseOnce = false;
        pushedAsLinearComments = [...pushedAsLinearComments, linearComment(`lc-pushed-${++counter}`, (variables['input'] as { body: string }).body)];
        throw new Error('socket hang up');
      }
      const id = `lc-pushed-${++counter}`;
      const input = variables['input'] as { body: string };
      const body = opts.echo === 'edited-body' ? 'someone edited the text so the signature is gone' : opts.unknownIdWithSignature ? input.body : input.body;
      pushedAsLinearComments = [...pushedAsLinearComments, linearComment(id, body)];
      return { commentCreate: { success: true, comment: { id, url: `https://linear.app/acme/issue/WB-1#comment-${id}` } } };
    }
    expect(apiKey).toBe(KEY);
    if (query.includes('query IssueComments')) {
      // #1102 — the write-back's own lookup: the comments on ONE issue, paged like Linear (the issue id is the filter)
      issueCommentReads.push(String(variables['id']));
      if (failLookups) throw new Error('Linear API 502 — lookup boom');
      const all = [...pushedAsLinearComments].filter((c) => (c['issue'] as { id: string }).id === variables['id']);
      const start = variables['after'] ? Number(variables['after']) : 0;
      const nodes = all.slice(start, start + 2);
      return { comments: { nodes, pageInfo: { hasNextPage: start + nodes.length < all.length, endCursor: String(start + nodes.length) } } };
    }
    return base(query, variables, apiKey);
  };
  linear.fetcher = f;
}
const commentsOnRecord = async () => (await inject('GET', `/workspaces/${ws}/databases/${dbId}/records/${recId}/comments`)).json().data as Array<{ id: string; body: { doc?: unknown[] } | unknown[]; source: string | null }>;
const addComment = async (text: string) => {
  const r = await inject('POST', `/workspaces/${ws}/databases/${dbId}/records/${recId}/comments`, { body: [{ type: 'text', text }] });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json().id as string;
};
const pushRow = async (commentId: string) => ((await (app.get(DB) as Db).execute(sql`select status, attempts, linear_comment_id, last_error from linear_comment_pushes where comment_id = ${commentId}`)).rows[0] ?? null) as { status: string; attempts: number; linear_comment_id: string | null; last_error: string | null } | null;

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  wb = app.get(LinearWriteBackService);
  admin = await signUpUser(app, 'Wendy Writer');
  ws = (await inject('POST', '/workspaces', { name: 'Linear WriteBack WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: KEY, team_keys: ['WB'] })).statusCode).toBe(201);
  installLinear();
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
  const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json();
  dbId = dbs.find((d: { name: string }) => d.name === 'Issues').id;
  const rec = (await inject('GET', `/workspaces/${ws}/databases/${dbId}/records?limit=5`)).json().data[0];
  recId = rec.id;
  issueUuid = 'iss-0';
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#907 write-back', () => {
  it('is OFF by default: a comment written in StoryOS is not pushed, and the config never shows the key', async () => {
    await addComment('written before write-back was on');
    await wb.tick();
    expect(sent).toHaveLength(0);
    const cfg = await inject('GET', `/workspaces/${ws}/integrations/linear`);
    expect(cfg.json().write_back).toEqual({ enabled: false, pending: 0, failed: 0, last_error: null });
    expect(cfg.body, 'the key is never returned').not.toContain(KEY);
  });

  it('switched on, history is NOT replayed; a new comment is pushed once, signed on its first line, with the Linear issue id', async () => {
    const on = await inject('POST', `/workspaces/${ws}/integrations/linear`, { write_back: { enabled: true } });
    expect(on.statusCode, on.body).toBe(201);
    expect(on.json().write_back.enabled).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const id = await addComment('Found the cause: the cache key ignores the locale.');
    await wb.tick();
    await wb.tick(); // a second tick must not send it again
    expect(sent, 'exactly one push').toHaveLength(1);
    const call = sent[0]!;
    expect(call.query).toBe(COMMENT_CREATE_MUTATION);
    const input = call.vars['input'] as { issueId: string; body: string };
    expect(input.issueId).toBe(issueUuid);
    expect(input.body.split('\n')[0]).toBe('**Wendy Writer · via StoryOS**');
    expect(input.body).toContain('Found the cause: the cache key ignores the locale.');
    const row = await pushRow(id);
    expect(row).toMatchObject({ status: 'sent', attempts: 1 });
    expect(row!.linear_comment_id, 'the Linear id that came back is stored').toMatch(/^lc-pushed-/);
    expect(await pushRow((await commentsOnRecord()).find((c) => JSON.stringify(c.body).includes('before write-back'))!.id), 'history not queued').toBeNull();
  });

  it('writes ONLY comments to Linear: the single mutation ever sent is commentCreate', async () => {
    for (const c of sent) {
      expect(c.query).toContain('commentCreate');
      expect(c.query).not.toMatch(/issueUpdate|issueCreate|issueArchive|issueDelete|commentUpdate|commentDelete/);
    }
  });

  it('NO ECHO: the next sync imports the human Linear comment, not our pushed one (the id is stored and checked)', async () => {
    // Linear serves our pushed comment back with the signature edited away: only the stored id can catch it
    pushedAsLinearComments = pushedAsLinearComments.map((c) => ({ ...c, body: 'someone edited the text so the signature is gone' }));
    installLinear();
    const before = (await commentsOnRecord()).length;
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().comments.fetched).toBeGreaterThanOrEqual(2);
    const after = await commentsOnRecord();
    // the human Linear comment was imported by the first sync; the pushed one must not appear as a new comment
    expect(after.length - before).toBe(0);
    expect(JSON.stringify(after)).not.toContain('someone edited the text');
    await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect((await commentsOnRecord()).length, 'and a second sync adds nothing').toBe(after.length);
  });

  it('NO ECHO, second guard: a Linear comment whose first line is signed "· via StoryOS" is skipped even if its id is unknown', async () => {
    pushedAsLinearComments = [...pushedAsLinearComments, linearComment('lc-unknown', '**Vale (validator) · via StoryOS**\n\nPosted before we stored ids')];
    installLinear();
    const before = (await commentsOnRecord()).length;
    await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect((await commentsOnRecord()).length).toBe(before);
    expect(JSON.stringify(await commentsOnRecord())).not.toContain('Posted before we stored ids');
  });

  it('an imported Linear comment is never pushed back, even one written in Linear AFTER write-back was switched on', async () => {
    // a brand-new human comment in Linear: imported with its real (recent) time, so only the source/footer guards keep it out
    pushedAsLinearComments = [...pushedAsLinearComments, { ...linearComment('lc-fresh', 'Fresh human comment'), createdAt: new Date().toISOString() }];
    installLinear();
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
    const imported = (await commentsOnRecord()).filter((c) => c.source === 'automation');
    expect(imported.length).toBeGreaterThan(0);
    await wb.tick();
    for (const c of imported) expect(await pushRow(c.id)).toBeNull();
    expect(sent, 'still only the one real push').toHaveLength(1);
  });

  it('an agent comment is signed with the AGENT\'s name', async () => {
    const id = await addComment('Agent finding');
    await (app.get(DB) as Db).execute(sql`update comments set agent_name = 'Vale (validator)', source = 'mcp' where id = ${id}`);
    installLinear();
    await wb.tick();
    expect((sent.at(-1)!.vars['input'] as { body: string }).body.split('\n')[0]).toBe('**Vale (validator) · via StoryOS**');
  });

  it('a failed push is retried on a backoff, then visibly marked ON the comment and the author is told; the key never leaks', async () => {
    installLinear();
    const id = await addComment('This one will fail');
    failPushes = true;
    let t = Date.now();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await wb.tick(new Date(t));
      expect((await pushRow(id))!.attempts).toBe(attempt);
      t += 2 * 60 * 60_000; // past any backoff
    }
    const row = (await pushRow(id))!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('Linear API 500');
    const body = JSON.stringify((await commentsOnRecord()).find((c) => c.id === id)!.body);
    expect(body).toContain('Not delivered to Linear after 5 attempts');
    const cfg = (await inject('GET', `/workspaces/${ws}/integrations/linear`)).json();
    expect(cfg.write_back.failed).toBe(1);
    expect(JSON.stringify(cfg)).not.toContain(KEY);
    const notes = (await inject('GET', `/workspaces/${ws}/notifications`)).json().data as Array<{ snippet: string }>;
    expect(notes.some((n) => (n.snippet ?? '').includes('not delivered to Linear'))).toBe(true);
    failPushes = false;
  });
});

/**
 * #1102 — "exactly once" across a fault between Linear accepting the comment and StoryOS recording that it did.
 * The fault is injected AT that point; the assertion is on what Linear holds, not on StoryOS's own bookkeeping.
 */
describe('#1102 write-back survives a fault after Linear accepted the comment', () => {
  const linearHolds = (needle: string) => pushedAsLinearComments.filter((c) => String(c['body']).includes(needle));
  const HOUR = 60 * 60_000;

  it('response lost after Linear stored the comment: the retry adopts it instead of sending a second one', async () => {
    installLinear();
    const id = await addComment('LOSTRESP finding about the cache');
    const before = sent.length;
    loseResponseOnce = true;
    let t = Date.now();
    await wb.tick(new Date(t));
    expect((await pushRow(id))!.status, 'first attempt looked like a failure to us').toBe('pending');
    expect(linearHolds('LOSTRESP'), 'but Linear has it').toHaveLength(1);
    t += 2 * HOUR;
    await wb.tick(new Date(t));
    expect(linearHolds('LOSTRESP'), 'still exactly one comment on the Linear ticket').toHaveLength(1);
    expect(sent.length - before, 'no second commentCreate was sent').toBe(1);
    const row = (await pushRow(id))!;
    expect(row.status).toBe('sent');
    expect(row.linear_comment_id, 'the id of the comment that is really there is stored').toBe(linearHolds('LOSTRESP')[0]!['id']);
  });

  it('crash between the send and the record (row left in "sending"): the next run does not resend', async () => {
    installLinear();
    const id = await addComment('CRASHED finding about the locale');
    // the send went through; the process died before the UPDATE to 'sent' — reproduced by undoing that UPDATE
    await wb.tick();
    expect(linearHolds('CRASHED')).toHaveLength(1);
    await (app.get(DB) as Db).execute(sql`update linear_comment_pushes set status = 'sending', linear_comment_id = null, linear_comment_url = null, updated_at = now() - interval '11 minutes' where comment_id = ${id}`);
    const before = sent.length;
    await wb.tick();
    expect(linearHolds('CRASHED'), 'still exactly one on the Linear ticket').toHaveLength(1);
    expect(sent.length - before, 'no second commentCreate').toBe(0);
    expect(await pushRow(id)).toMatchObject({ status: 'sent', linear_comment_id: linearHolds('CRASHED')[0]!['id'] });
  });

  it('finds the comment on a later page of a busy issue', async () => {
    installLinear();
    const id = await addComment('PAGED finding');
    await wb.tick();
    // bury it under newer comments so the lookup must page (the test Linear pages by 2)
    pushedAsLinearComments = [...pushedAsLinearComments, ...[1, 2, 3].map((n) => linearComment(`lc-pad-${n}`, '**Pad · via StoryOS**\n\npad'))];
    await (app.get(DB) as Db).execute(sql`update linear_comment_pushes set status = 'sending', linear_comment_id = null, updated_at = now() - interval '11 minutes' where comment_id = ${id}`);
    const before = sent.length;
    await wb.tick();
    expect(sent.length - before).toBe(0);
    expect((await pushRow(id))!.status).toBe('sent');
  });

  it('MUST STILL SEND: a comment that never reached Linear is sent on retry (the lookup finds nothing)', async () => {
    installLinear();
    const id = await addComment('NEVERSENT finding');
    failPushes = true;
    const t = Date.now();
    await wb.tick(new Date(t));
    failPushes = false;
    expect(linearHolds('NEVERSENT')).toHaveLength(0);
    issueCommentReads.length = 0;
    await wb.tick(new Date(t + 2 * HOUR));
    expect(issueCommentReads.length, 'a retry looked first').toBeGreaterThan(0);
    expect(linearHolds('NEVERSENT'), 'and then sent it').toHaveLength(1);
    expect((await pushRow(id))!.status).toBe('sent');
  });

  it('a lookup that fails never falls through to a blind resend; it backs off and tries again later', async () => {
    installLinear();
    const id = await addComment('LOOKUPFAIL finding');
    loseResponseOnce = true;
    let t = Date.now();
    await wb.tick(new Date(t));
    expect(linearHolds('LOOKUPFAIL')).toHaveLength(1);
    failLookups = true;
    t += 2 * HOUR;
    const before = sent.length;
    await wb.tick(new Date(t));
    expect(sent.length - before, 'did not resend blind').toBe(0);
    expect((await pushRow(id))).toMatchObject({ status: 'pending' });
    expect((await pushRow(id))!.last_error).toContain('lookup boom');
    failLookups = false;
    t += 2 * HOUR;
    await wb.tick(new Date(t));
    expect(linearHolds('LOOKUPFAIL')).toHaveLength(1);
    expect((await pushRow(id))!.status).toBe('sent');
  });

  it('NO ECHO still holds: the marked comment coming back from Linear is not imported, even with its stored id forgotten', async () => {
    installLinear();
    const id = await addComment('ECHOCHECK finding');
    await wb.tick();
    const posted = linearHolds('ECHOCHECK')[0]!;
    expect(String(posted['body']).split('\n')[0], 'signed first line unchanged').toMatch(/ · via StoryOS\*\*$/);
    await (app.get(DB) as Db).execute(sql`update linear_comment_pushes set linear_comment_id = null where comment_id = ${id}`);
    const before = (await commentsOnRecord()).length;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
    const after = await commentsOnRecord();
    expect(after.length).toBe(before);
    expect(JSON.stringify(after)).not.toContain('storyos-comment-');
  });
});
