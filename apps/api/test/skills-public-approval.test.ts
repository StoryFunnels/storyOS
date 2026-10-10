import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, skills, user } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { SkillsService } from '../src/skills/skills.service';
import { SkillPublishGateService } from '../src/automations/skill-publish-gate.service';

/**
 * #867 AC3 — `public` is the ONE tier an AI may only PROPOSE: the skill stays as it was, a person
 * approves in the Inbox, and only then does it become public. The approval is human-sourced only
 * (#859), so the credential that proposed cannot approve it, even an admin's.
 *
 * The adversarial core is the SAME admin identity, once as a token and once as a session, against
 * the SAME pending proposal; and the fail-closed rule (AC10): with no approval path registered, a
 * token asking for `public` is a 403, never a silent allow.
 */
let app: NestFastifyApplication;
let db: Db;
let jobs: JobRunnerService;
let tokens: TokensService;
let admin: { token: string; email: string };
let adminId: string;
let teammate: { token: string; email: string };
let wsId: string;
let pat: string;
let agent: string;

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? undefined) as never });
const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: 'd', when_to_use: 'w', instructions: `instructions of ${name}`, ...extra,
});
const stored = async (id: string) => (await db.query.skills.findFirst({ where: eq(skills.id, id) }))!;
const approvalRow = async (id: string) => (await db.query.approvals.findFirst({ where: eq(approvals.id, id) }))!;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  jobs = app.get(JobRunnerService);
  tokens = app.get(TokensService);
  admin = await signUpUser(app, 'PubApproval Admin');
  teammate = await signUpUser(app, 'PubApproval Teammate');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await call(admin.token, 'POST', '/workspaces', { name: 'pub approval' })).json().id;
  const inv = await call(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: teammate.email, role: 'member' });
  await call(teammate.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  pat = (await tokens.create(adminId, wsId, 'pat', 'admin', true)).token;
  agent = (await tokens.create(adminId, wsId, 'agent', 'admin', true, 'agent')).token;
});

afterAll(async () => {
  await app.close();
});

describe('#867 AC3 — an AI asking for `public` raises a proposal; nothing is public until a person approves', () => {
  it('create with visibility public: the skill is PERSONAL, no public link exists, and a pending approval names the owner', async () => {
    const res = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('wants to be public', { visibility: 'public' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().visibility, 'held: not public, not even workspace-visible, meanwhile').toBe('personal');
    expect(res.json().pending_approval?.id).toBeTruthy();
    const row = await stored(res.json().id);
    expect(row.visibility).toBe('personal');
    expect(row.publicToken, 'no public link minted by a proposal').toBeNull();
    const ap = await approvalRow(res.json().pending_approval.id);
    expect(ap.status).toBe('pending');
    expect(ap.approverId, 'the token owner (a person) is the approver').toBe(adminId);
    expect((ap.actionSnapshot as { action: { type: string; skill_id: string } }).action).toMatchObject({ type: 'skill_publish_public', skill_id: res.json().id });
    // It shows in the approver's list (what the Inbox reads) ...
    const list = await call(admin.token, 'GET', `/workspaces/${wsId}/approvals?status=pending`);
    expect(JSON.stringify(list.json())).toContain(ap.id);
    // ... and the person is actually TOLD: an Inbox notification carrying the approval id, since the
    // Inbox's Approve/Reject buttons hang off `ref_id` (a swallowed notify failure would be silent).
    const inbox = await call(admin.token, 'GET', `/workspaces/${wsId}/notifications`);
    const inboxRow = (inbox.json().data as Array<{ type: string; ref_id: string | null; snippet: string | null }>).find((n) => n.ref_id === ap.id);
    expect(inboxRow, 'an Inbox row for this approval').toBeTruthy();
    expect(inboxRow!.type).toBe('action_approval_requested');
    expect(inboxRow!.snippet).toContain('wants to be public');
  });

  it('THE ADVERSARIAL CASE: the SAME admin as a token (mcp or agent) cannot approve it; stored state unchanged; a person can', async () => {
    const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('approve me', { visibility: 'public' }));
    const approvalId = made.json().pending_approval.id as string;
    for (const [label, t] of [['mcp', pat], ['agent', agent]] as const) {
      const res = await call(t, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(403);
    }
    await jobs.tick();
    expect((await approvalRow(approvalId)).status, 'still pending after both refusals').toBe('pending');
    expect((await stored(made.json().id)).visibility, 'and the skill is not public').toBe('personal');
    // The person (a browser session) decides.
    const person = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(person.statusCode, person.body).toBeLessThan(300);
    await jobs.tick();
    const row = await stored(made.json().id);
    expect(row.visibility, 'public only on the human approval').toBe('public');
    expect(row.publicToken).toBeTruthy();
    // And the link really works, unauthenticated.
    const read = await app.inject({ method: 'GET', url: `/api/v1/public/skills/${row.publicToken}` });
    expect(read.statusCode, read.body).toBe(200);
  });

  it('PATCH an existing shared skill to public: visibility is UNCHANGED, the rest of the edit applies, and a rejection leaves it shared', async () => {
    const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('shared one'));
    expect(made.json().visibility).toBe('shared');
    const patch = await call(pat, 'PATCH', `/workspaces/${wsId}/skills/${made.json().id}`, { visibility: 'public', description: 'edited meanwhile' });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().visibility).toBe('shared');
    expect(patch.json().description, 'the rest of the edit still applied').toBe('edited meanwhile');
    const approvalId = patch.json().pending_approval.id as string;
    const reject = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`, { reason: 'no' });
    expect(reject.statusCode, reject.body).toBeLessThan(300);
    await jobs.tick();
    const row = await stored(made.json().id);
    expect(row.visibility, 'rejected: nothing changed').toBe('shared');
    expect(row.publicToken).toBeNull();
  });

  it('a different member (neither admin nor the named approver) cannot approve; `members` is still refused outright', async () => {
    const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('not yours to approve', { visibility: 'public' }));
    const res = await call(teammate.token, 'POST', `/workspaces/${wsId}/approvals/${made.json().pending_approval.id}/approve`);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(403);
    expect(res.statusCode).toBeLessThan(500);
    expect((await stored(made.json().id)).visibility).toBe('personal');
    const members = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('named', { visibility: 'members', member_ids: [adminId] }));
    expect(members.statusCode, members.body).toBe(403);
  });

  it('approving after the skill was DELETED is a no-op, not a crash', async () => {
    const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('gone before approval', { visibility: 'public' }));
    expect((await call(admin.token, 'DELETE', `/workspaces/${wsId}/skills/${made.json().id}`)).statusCode).toBeLessThan(300);
    const res = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${made.json().pending_approval.id}/approve`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    await jobs.tick();
    expect(await db.query.skills.findFirst({ where: eq(skills.id, made.json().id) })).toBeUndefined();
  });
});

describe('#867 — a BURST of proposals: each one has its own actionable Inbox entry', () => {
  it('an AI asks for `public` on five skills within a minute: five approvals, five Inbox rows, each row\'s ref_id its own approval, and deciding one leaves the others actionable', async () => {
    const approvalIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill(`burst ${i}`, { visibility: 'public' }));
      expect(made.statusCode, made.body).toBe(201);
      approvalIds.push(made.json().pending_approval.id as string);
    }
    expect(new Set(approvalIds).size, 'five distinct approvals').toBe(5);
    const inbox = (await call(admin.token, 'GET', `/workspaces/${wsId}/notifications`)).json().data as Array<{ type: string; ref_id: string | null; read_at: string | null }>;
    const rows = inbox.filter((n) => n.type === 'action_approval_requested' && n.ref_id && approvalIds.includes(n.ref_id));
    expect(rows.map((n) => n.ref_id).sort(), 'every proposal has an Inbox row carrying ITS approval id (none collapsed away)').toEqual([...approvalIds].sort());
    // Decide one: the other four are still pending and each still has its row.
    expect((await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalIds[2]}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();
    const pending = (await call(admin.token, 'GET', `/workspaces/${wsId}/approvals?status=pending`)).json() as Array<{ id: string }>;
    for (const id of approvalIds.filter((_, i) => i !== 2)) {
      expect(pending.map((p) => p.id), `still pending: ${id}`).toContain(id);
    }
  });
});

describe('#869 — a decided public-skill approval refuses the opposite decision, and the SKILL\'s state is asserted, not just the approval\'s', () => {
  it('Reject AFTER Approve: refused 409 with a reason; the skill is STILL public with the SAME token; the approval stays approved', async () => {
    const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('regretted approval', { visibility: 'public' }));
    const approvalId = made.json().pending_approval.id as string;
    expect((await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();
    const before = await stored(made.json().id);
    expect(before.visibility).toBe('public');
    expect(before.publicToken).toBeTruthy();

    const late = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`, { reason: 'oops' });
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error.message, 'tells the person it was NOT undone').toMatch(/already approved/i);
    await jobs.tick();
    const after = await stored(made.json().id);
    expect(after.visibility, 'the skill is STILL public: a Reject that "worked" would have lied').toBe('public');
    expect(after.publicToken, 'and the link is unchanged').toBe(before.publicToken);
    expect((await approvalRow(approvalId)).status).toBe('approved');
    // The unauthenticated link still reads (this is exactly what a regretful person must understand).
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/skills/${before.publicToken}` })).statusCode).toBe(200);
  });

  it('Approve AFTER Reject: refused 409; the skill never becomes public, no token, even after a job tick', async () => {
    const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('rejected then approved', { visibility: 'public' }));
    const approvalId = made.json().pending_approval.id as string;
    expect((await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`, { reason: 'no' })).statusCode).toBeLessThan(300);
    const late = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error.message).toMatch(/already rejected/i);
    await jobs.tick();
    const row = await stored(made.json().id);
    expect(row.visibility).toBe('personal');
    expect(row.publicToken).toBeNull();
    expect((await approvalRow(approvalId)).status).toBe('rejected');
  });

  it('Approve twice with the same token is idempotent by design (a double click), and mints ONE link', async () => {
    const made = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('double approve', { visibility: 'public' }));
    const approvalId = made.json().pending_approval.id as string;
    const a = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    const b = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(a.statusCode).toBeLessThan(300);
    expect(b.statusCode).toBeLessThan(300);
    await jobs.tick();
    const first = (await stored(made.json().id)).publicToken;
    await jobs.tick();
    expect((await stored(made.json().id)).publicToken, 'the token did not change').toBe(first);
  });
});

describe('#867 AC10 — fail closed: with NO approval path registered, `public` from a token is a 403, never an allow', () => {
  it('unregistered gate -> 403 on create and update, nothing created or changed; re-registering restores the proposal', async () => {
    const svc = app.get(SkillsService);
    const gate = app.get(SkillPublishGateService);
    const keep = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('keep as is'));
    svc.registerPublicGate(null);
    try {
      const create = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('refused public', { visibility: 'public' }));
      expect(create.statusCode, create.body).toBe(403);
      expect(await db.query.skills.findFirst({ where: eq(skills.name, 'refused public') }), 'nothing was created').toBeUndefined();
      const update = await call(pat, 'PATCH', `/workspaces/${wsId}/skills/${keep.json().id}`, { visibility: 'public' });
      expect(update.statusCode, update.body).toBe(403);
      expect((await stored(keep.json().id)).visibility).toBe('shared');
    } finally {
      svc.registerPublicGate(gate);
    }
    const back = await call(pat, 'POST', `/workspaces/${wsId}/skills`, skill('proposal again', { visibility: 'public' }));
    expect(back.statusCode, back.body).toBe(201);
    expect(back.json().pending_approval?.id).toBeTruthy();
  });

  it('a PERSON (session) making a skill public directly is unchanged: no approval, public at once', async () => {
    const res = await call(admin.token, 'POST', `/workspaces/${wsId}/skills`, skill('person public', { visibility: 'public' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().visibility).toBe('public');
    expect(res.json().pending_approval).toBeUndefined();
  });
});
