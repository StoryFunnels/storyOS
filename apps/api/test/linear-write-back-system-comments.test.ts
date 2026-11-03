import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import type { RunCredentialWorld } from './helpers/run-credential-fixture';
import { makeLinearFetcher } from './helpers/linear-fake';
import { AutomationsService } from '../src/automations/automations.service';
import { ApprovalsService } from '../src/automations/approvals.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { LinearService } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';
import { LinearWriteBackService } from '../src/integrations/linear-write-back.service';

/**
 * #1181 — what StoryOS writes ITSELF on a record (an approval decision, an expiry, a run notice, a duplicate note) is internal and is
 * never pushed to Linear. The rule is positive and lives at the outbox's one choke point: only a comment a person (human / mcp) or an
 * agent wrote as conversation is eligible; anything else, including an origin nobody recognises, is refused.
 *
 * Fixtures are real: a member, an admin, a record mirrored from Linear (carries `linear_id`), an automation rule that gates an action
 * behind an approval, and the audit's real per-run agent credential. The Linear client seam records every commentCreate that is sent.
 */
let app: NestFastifyApplication;
let w: RunCredentialWorld;
const { pool } = connectTestDb();
const SECRET = 'INTERNAL-REASON-do-not-leak-1181';
const mutations: Array<{ issueId: string; body: string }> = [];
let wb: LinearWriteBackService;
let approvals: ApprovalsService;
let mirroredDb: string;

const post = (token: string, method: string, url: string, payload?: unknown) => w.as(token, method, `/workspaces/${w.ws}${url}`, payload);
const sentBodies = () => mutations.map((m) => m.body).join('\n---\n');
const pushRow = async (commentId: string) => (await pool.query('select status, last_error from linear_comment_pushes where comment_id = $1', [commentId])).rows[0] as { status: string; last_error: string | null } | undefined;
const commentsOn = async (recId: string) => (await pool.query('select id, source, body::text as text from comments where record_id = $1 order by created_at', [recId])).rows as Array<{ id: string; source: string | null; text: string }>;
const commentWith = async (recId: string, needle: string) => {
  const c = (await commentsOn(recId)).find((x) => x.text.includes(needle));
  expect(c, `a comment containing "${needle}" exists`).toBeTruthy();
  return c!;
};

/** A record mirrored from Linear, with a rule that gates `add_comment` behind an approval: returns the record and its pending approval. */
let ruleId: string;
const mirroredWithPendingApproval = async (title: string) => {
  const rec = (await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records`, { values: { name: title, linear_id: `issue-${randomUUID()}` } })).json().id as string;
  await app.get(AutomationsService).settle(rec);
  const row = (await pool.query("select id from approvals where record_id = $1 and rule_id = $2 and status = 'pending'", [rec, ruleId])).rows[0] as { id: string };
  return { rec, approvalId: row.id };
};

beforeAll(async () => {
  app = await createTestApp();
  w = await buildRunCredentialWorld(app, pool, 'Sys1181');
  wb = app.get(LinearWriteBackService);
  approvals = app.get(ApprovalsService);
  expect((await post(w.admin.token, 'POST', '/integrations/linear', { api_key: 'lin_api_1181', team_keys: ['WB'] })).statusCode).toBe(201);
  const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
  const base = makeLinearFetcher([{ id: 'team-w', key: 'WB', name: 'WB', data: { ...empty, issues: { nodes: [] }, comments: [] } }]).fetcher;
  const f: LinearFetcher = async (query, variables, apiKey) => {
    if (query.includes('mutation')) {
      const input = variables['input'] as { issueId: string; body: string };
      mutations.push(input);
      return { commentCreate: { success: true, comment: { id: `lc-${mutations.length}`, url: `https://linear.app/acme/issue/WB-1#comment-lc-${mutations.length}` } } };
    }
    return base(query, variables, apiKey);
  };
  app.get(LinearService).fetcher = f;
  mirroredDb = w.ticketsDbId;
  const fld = await post(w.admin.token, 'POST', `/databases/${mirroredDb}/fields`, { display_name: 'Linear Id', type: 'text', config: {} });
  expect(fld.json().apiName).toBe('linear_id');
  const rule = await post(w.admin.token, 'POST', `/databases/${mirroredDb}/automations`, {
    name: `Gate ${randomUUID()}`,
    trigger: { type: 'record_created' },
    actions: [{ type: 'add_comment', body_template: 'Automated note for {Title}', require_approval: true }],
  });
  expect(rule.statusCode, rule.body).toBe(201);
  ruleId = rule.json().id as string;
  expect((await post(w.admin.token, 'POST', '/integrations/linear', { write_back: { enabled: true } })).statusCode).toBe(201);
  await new Promise((r) => setTimeout(r, 25)); // only comments written AFTER the switch are considered
}, 180_000);
afterAll(async () => {
  await pool.query("delete from automation_jobs where workspace_id = $1 and status = 'queued'", [w.ws]);
  await app.close();
  await pool.end();
});

describe('#1181 an approval decision on a Linear-mirrored record is never pushed to Linear', () => {
  it('REJECT with a reason: the audit comment is on the record, and NOTHING reaches Linear', async () => {
    mutations.length = 0;
    const { rec, approvalId } = await mirroredWithPendingApproval('Reject me');
    const res = await post(w.admin.token, 'POST', `/approvals/${approvalId}/reject`, { reason: SECRET });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const audit = await commentWith(rec, SECRET);
    expect(audit.text, 'the audit comment exists in StoryOS, so a silent absence would mean nothing').toContain('Rejected:');
    await wb.tick();
    await wb.tick();
    expect(sentBodies()).not.toContain(SECRET);
    expect(mutations, 'nothing at all was sent for this record').toHaveLength(0);
    expect(await pushRow(audit.id), 'never even queued').toBeUndefined();
    expect(audit.source, 'written by the system, not by the approver as a person').toBe('automation');
  });

  it('APPROVE: the "Approved: ..." audit comment (and the executed action\'s own comment) are not sent', async () => {
    mutations.length = 0;
    const { rec, approvalId } = await mirroredWithPendingApproval('Approve me');
    expect((await post(w.admin.token, 'POST', `/approvals/${approvalId}/approve`, {})).statusCode).toBeLessThan(300);
    await app.get(JobRunnerService).tick();
    const audit = await commentWith(rec, 'Approved:');
    await wb.tick();
    expect(mutations).toHaveLength(0);
    expect(await pushRow(audit.id)).toBeUndefined();
    // every comment on this record was written by the system: none is queued
    for (const c of await commentsOn(rec)) expect(await pushRow(c.id), `comment ${c.text.slice(0, 40)}`).toBeUndefined();
  });

  it('EXPIRY: the "Expired without a decision" comment is not sent', async () => {
    mutations.length = 0;
    const { rec, approvalId } = await mirroredWithPendingApproval('Expire me');
    await pool.query("update approvals set expires_at = now() - interval '1 second' where id = $1", [approvalId]);
    await approvals.expireStale();
    const audit = await commentWith(rec, 'Expired without a decision');
    await wb.tick();
    expect(mutations).toHaveLength(0);
    expect(await pushRow(audit.id)).toBeUndefined();
  });

  it('a duplicate of a mirrored record: its "N comments copied" note is system-written and not sent', async () => {
    mutations.length = 0;
    const rec = (await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records`, { values: { name: 'Has a thread', linear_id: `issue-${randomUUID()}` } })).json().id as string;
    await app.get(AutomationsService).settle(rec);
    await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records/${rec}/comments`, { body: [{ type: 'text', text: 'a thread comment' }] });
    const dup = await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records/${rec}/duplicate`);
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const dupId = dup.json().id as string;
    const note = await commentWith(dupId, 'copied from');
    expect(note.source).toBe('automation');
    await wb.tick();
    expect(sentBodies()).not.toContain('copied from');
  });
});

describe('#1181 MUST KEEP WORKING: what a person or an agent wrote as conversation still goes out', () => {
  it('a member\'s and an admin\'s comment on a mirrored record are each sent, signed', async () => {
    mutations.length = 0;
    const rec = (await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records`, { values: { name: 'Plain', linear_id: `issue-${randomUUID()}` } })).json().id as string;
    await app.get(AutomationsService).settle(rec);
    for (const [token, text] of [[w.admin.token, 'admin says hi 1181'], [w.owner.token, 'member says hi 1181']] as const) {
      const r = await post(token, 'POST', `/databases/${mirroredDb}/records/${rec}/comments`, { body: [{ type: 'text', text }] });
      expect(r.statusCode, r.body).toBe(201);
    }
    await wb.tick();
    expect(mutations.map((m) => m.body).filter((b) => b.includes('says hi 1181'))).toHaveLength(2);
  });

  it('an agent comment follows the #1179 setting: sent by default, HELD when approval is required (nothing leaks either way)', async () => {
    const rec = (await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records`, { values: { name: 'Agent target', linear_id: `issue-${randomUUID()}` } })).json().id as string;
    await app.get(AutomationsService).settle(rec);
    mutations.length = 0;
    const r1 = await post(w.credential, 'POST', `/databases/${mirroredDb}/records/${rec}/comments`, { body: [{ type: 'text', text: 'agent finding default 1181' }] });
    expect(r1.statusCode, r1.body).toBe(201);
    await wb.tick();
    expect(mutations.filter((m) => m.body.includes('agent finding default 1181'))).toHaveLength(1);
    expect((await post(w.admin.token, 'POST', '/integrations/linear', { write_back: { require_approval_for_agent_comments: true } })).statusCode).toBe(201);
    mutations.length = 0;
    const r2 = await post(w.credential, 'POST', `/databases/${mirroredDb}/records/${rec}/comments`, { body: [{ type: 'text', text: 'agent finding held 1181' }] });
    await wb.tick();
    expect(mutations).toHaveLength(0);
    expect((await pushRow(r2.json().id as string))?.status).toBe('held');
    expect((await post(w.admin.token, 'POST', '/integrations/linear', { write_back: { require_approval_for_agent_comments: false } })).statusCode).toBe(201);
  });
});

describe('#1181 the choke point is positive: unknown origins are refused, and queued rows are re-checked at send time', () => {
  it('a comment whose origin is not recorded (source null) is never queued', async () => {
    mutations.length = 0;
    const rec = (await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records`, { values: { name: 'Unknown origin', linear_id: `issue-${randomUUID()}` } })).json().id as string;
    const id = (await post(w.admin.token, 'POST', `/databases/${mirroredDb}/records/${rec}/comments`, { body: [{ type: 'text', text: 'origin unknown 1181' }] })).json().id as string;
    await pool.query('update comments set source = null where id = $1', [id]);
    await wb.tick();
    expect(await pushRow(id)).toBeUndefined();
    expect(mutations).toHaveLength(0);
  });

  it('a row ALREADY QUEUED before the fix for a system comment is dropped at send time, with the reason on the row, and never sent', async () => {
    mutations.length = 0;
    const { rec, approvalId } = await mirroredWithPendingApproval('Queued earlier');
    await post(w.admin.token, 'POST', `/approvals/${approvalId}/reject`, { reason: SECRET });
    const audit = await commentWith(rec, SECRET);
    const issue = (await pool.query("select values->>(select id::text from fields where database_id = $1 and api_name = 'linear_id') as v from records where id = $2", [mirroredDb, rec])).rows[0].v as string;
    // what an older build left behind: a pending outbox row for the audit comment
    await pool.query("insert into linear_comment_pushes (comment_id, workspace_id, linear_issue_id, next_attempt_at) values ($1, $2, $3, now())", [audit.id, w.ws, issue]);
    // the app's own interval tick may be mid-pass in the shared full run, so tick until the row is handled (bounded), not once
    for (let i = 0; i < 5 && (await pushRow(audit.id))?.status === 'pending'; i++) await wb.tick(new Date(Date.now() + 60_000));
    expect(mutations).toHaveLength(0);
    const row = (await pushRow(audit.id))!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/internal|system/i);
  });
});
