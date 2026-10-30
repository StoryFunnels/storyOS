import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed } from './helpers/users';
import { joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import type { RunCredentialWorld } from './helpers/run-credential-fixture';
import { HELD_DELETE_ROUTES } from './helpers/outward-audit';
import { RecordsService } from '../src/records/records.service';

/**
 * #1178 — an agent's own `delete` approval_policy must hold the DIRECT delete routes a Runner RUN CREDENTIAL can reach, not only the
 * delete a server-run agent proposes (agents.service.ts) or the one a manager declared a #542 gate for.
 *
 * Every test uses the audit's REAL run credential (a Runner paired and a wake claimed over HTTP, helpers/run-credential-fixture.ts).
 * The table below is keyed by the SAME route keys the sweep enumerates (HELD_DELETE_ROUTES), and the last test fails when a held
 * route has no fixture here: a fixture that is a prefix of the routes would pass for exactly the routes it omits.
 */
let app: NestFastifyApplication;
let w: RunCredentialWorld;
let guest: Person;
let otherMember: Person;
const { pool } = connectTestDb();

let linkFieldId: string;
let linkFieldApi: string;

const BOUNDARY = 'b1178';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  app = await createTestApp();
  w = await buildRunCredentialWorld(app, pool, 'Del1178');
  otherMember = await joinAs(app, w.admin.token, w.ws, 'Del1178Other', 'member');
  // a guest with partial access: a grant on ANOTHER database only, so every route below is one they cannot reach
  const elsewhere = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases`, { space_id: w.spaceId, name: 'Guest only' })).json().id as string;
  guest = await joinAs(app, w.admin.token, w.ws, 'Del1178Guest', 'guest', [{ database_id: elsewhere, role: 'editor' }]);
  const rel = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/relations`, {
    database_a_id: w.ticketsDbId,
    database_b_id: w.ticketsDbId,
    cardinality: 'many_to_many',
    field_a_name: 'Blocks',
    field_b_name: 'Blocked by',
  });
  expect(rel.statusCode, rel.body).toBeLessThan(300);
  linkFieldId = rel.json().field_a.id;
  linkFieldApi = rel.json().field_a.api_name ?? rel.json().field_a.apiName;
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

const base = () => `/workspaces/${w.ws}`;
const optionId = async (label: string) =>
  (await pool.query("select o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'approval_policy' and o.label = $2", [w.agentsDbId, label])).rows[0].id as string;
const setPolicy = async (labels: string[]) => {
  const ids = await Promise.all(labels.map(optionId));
  const r = await w.as(w.owner.token, 'PATCH', `${base()}/databases/${w.agentsDbId}/records/${w.agentId}`, { values: { approval_policy: ids } });
  expect(r.statusCode, r.body).toBe(200);
};
const count = async (sql: string, args: unknown[]) => Number((await pool.query(sql, args)).rows[0].n);

// ---- one fixture per held route: builds a FRESH target (made by a person, never by the credential) and says whether it still stands ----
interface Fx {
  method: string;
  url: string;
  body?: unknown;
  alive: () => Promise<boolean>;
  /** The status a successful (performed) call answers with. */
  doneStatus: number;
}
const ticket = async (name: string) => {
  const r = await w.as(w.admin.token, 'POST', `${base()}/databases/${w.ticketsDbId}/records`, { values: { name } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};
const recordAlive = (id: string) => async () => (await count('select count(*)::int as n from records where id = $1 and deleted_at is null', [id])) === 1;

const FIXTURES: Record<string, () => Promise<Fx>> = {
  'DELETE /workspaces/:ws/databases/:db/records/:rec': async () => {
    const id = await ticket(`Single ${randomUUID()}`);
    return { method: 'DELETE', url: `${base()}/databases/${w.ticketsDbId}/records/${id}`, alive: recordAlive(id), doneStatus: 200 };
  },
  'POST /workspaces/:ws/databases/:db/records/batch-delete': async () => {
    const ids = [await ticket(`B1 ${randomUUID()}`), await ticket(`B2 ${randomUUID()}`)];
    return {
      method: 'POST',
      url: `${base()}/databases/${w.ticketsDbId}/records/batch-delete`,
      body: { record_ids: ids },
      alive: async () => (await count('select count(*)::int as n from records where id = any($1) and deleted_at is null', [ids])) === ids.length,
      doneStatus: 201,
    };
  },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/links/:field': async () => {
    const a = await ticket(`LA ${randomUUID()}`);
    const b = await ticket(`LB ${randomUUID()}`);
    const linked = await w.as(w.admin.token, 'POST', `${base()}/databases/${w.ticketsDbId}/records/${a}/links/${linkFieldId}`, { record_ids: [b] });
    expect(linked.statusCode, linked.body).toBeLessThan(300);
    return {
      method: 'DELETE',
      url: `${base()}/databases/${w.ticketsDbId}/records/${a}/links/${linkFieldApi}`,
      body: { record_ids: [b] },
      alive: async () => (await count('select count(*)::int as n from record_links where (from_record_id = $1 and to_record_id = $2) or (from_record_id = $2 and to_record_id = $1)', [a, b])) > 0,
      doneStatus: 200,
    };
  },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/comments/:comment': async () => {
    const rec = await ticket(`C ${randomUUID()}`);
    // the credential acts AS its owner, and a comment may be deleted by its author: the owner writes it
    const c = await w.as(w.owner.token, 'POST', `${base()}/databases/${w.ticketsDbId}/records/${rec}/comments`, { body: [{ type: 'text', text: 'hello' }] });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as string;
    return {
      method: 'DELETE',
      url: `${base()}/databases/${w.ticketsDbId}/records/${rec}/comments/${id}`,
      alive: async () => (await count('select count(*)::int as n from comments where id = $1 and deleted_at is null', [id])) === 1,
      doneStatus: 200,
    };
  },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/attachments/:att': async () => {
    const rec = await ticket(`A ${randomUUID()}`);
    const body = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="p.png"\r\ncontent-type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST',
      url: `/api/v1${base()}/databases/${w.ticketsDbId}/records/${rec}/attachments`,
      headers: { ...authed(w.admin.token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: body,
    });
    expect(up.statusCode, up.body).toBe(201);
    const id = up.json().id as string;
    return {
      method: 'DELETE',
      url: `${base()}/databases/${w.ticketsDbId}/records/${rec}/attachments/${id}`,
      alive: async () => (await count('select count(*)::int as n from attachments where id = $1', [id])) === 1,
      doneStatus: 200,
    };
  },
  'DELETE /workspaces/:ws/documents/:doc': async () => {
    const d = await w.as(w.admin.token, 'POST', `${base()}/spaces/${w.spaceId}/documents`, { title: `Doc ${randomUUID()}` });
    expect(d.statusCode, d.body).toBe(201);
    const id = d.json().id as string;
    return {
      method: 'DELETE',
      url: `${base()}/documents/${id}`,
      alive: async () => (await count('select count(*)::int as n from space_documents where id = $1 and deleted_at is null', [id])) === 1,
      doneStatus: 200,
    };
  },
  'DELETE /workspaces/:ws/databases/:db/sources/:id': async () => {
    const field = (await pool.query("select id from fields where database_id = $1 and api_name = 'name'", [w.ticketsDbId])).rows[0].id as string;
    const row = await pool.query(
      "insert into sources (workspace_id, name, provider_source, target_database_id, external_key_field_id, schedule) values ($1, $2, 'apify.actor', $3, $4, 'day') returning id",
      [w.ws, `Src ${randomUUID()}`, w.ticketsDbId, field],
    );
    const id = row.rows[0].id as string;
    return {
      method: 'DELETE',
      url: `${base()}/databases/${w.ticketsDbId}/sources/${id}`,
      alive: async () => (await count('select count(*)::int as n from sources where id = $1', [id])) === 1,
      doneStatus: 200,
    };
  },
  'DELETE /workspaces/:ws/skills/:id': async () => {
    // authored by the credential's owner (a skill may be deleted by its owner only)
    const s = await w.as(w.owner.token, 'POST', `${base()}/skills`, { name: `Skill ${randomUUID()}`, description: 'd', when_to_use: 'w', instructions: 'i' });
    expect(s.statusCode, s.body).toBe(201);
    const id = s.json().id as string;
    return {
      method: 'DELETE',
      url: `${base()}/skills/${id}`,
      alive: async () => (await count('select count(*)::int as n from skills where id = $1', [id])) === 1,
      doneStatus: 200,
    };
  },
  'DELETE /workspaces/:ws/views/:view': async () => {
    const v = await w.as(w.admin.token, 'POST', `${base()}/spaces/${w.spaceId}/views`, { name: `Dash ${randomUUID()}`, type: 'dashboard', config: {} });
    expect(v.statusCode, v.body).toBe(201);
    const id = v.json().id as string;
    return {
      method: 'DELETE',
      url: `${base()}/views/${id}`,
      alive: async () => (await count('select count(*)::int as n from views where id = $1 and deleted_at is null', [id])) === 1,
      doneStatus: 200,
    };
  },
  'DELETE /workspaces/:ws/templates/sample-data': async () => {
    const applied = await w.as(w.admin.token, 'POST', `${base()}/templates/solo-dev/apply`, {});
    expect(applied.statusCode, applied.body).toBe(201);
    const samples = async () => ((await pool.query("select settings->'sample_record_ids' as ids from workspaces where id = $1", [w.ws])).rows[0].ids ?? []) as string[];
    expect((await samples()).length, 'the fixture made sample records').toBeGreaterThan(0);
    return { method: 'DELETE', url: `${base()}/templates/sample-data`, alive: async () => (await samples()).length > 0, doneStatus: 200 };
  },
};

/** Which people may perform it: a skill is deletable by its owner only. */
const FIXTURE_DELETERS = (key: string): Array<'admin' | 'owner'> => (key.includes('/skills/') ? ['owner'] : ['admin', 'owner']);

const approvalRows = async (match: string) =>
  (await pool.query("select id, status, preview_text, approver_id, action_snapshot from approvals where workspace_id = $1 and action_snapshot->'action'->>'type' = 'agent_delete' and action_snapshot->'action'->>'kind' = $2 order by created_at desc", [w.ws, match])).rows as Array<{
    id: string;
    status: string;
    preview_text: string;
    approver_id: string;
    action_snapshot: { action: Record<string, unknown>; ctx: Record<string, unknown> };
  }>;
const settle = async () => {
  const { JobRunnerService } = await import('../src/automations/job-runner.service');
  await app.get(JobRunnerService).tick();
};

describe('0. the enumeration and the fixtures agree', () => {
  it('every route the sweep says is HELD has a fixture here, and every fixture is a held route', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(HELD_DELETE_ROUTES).sort());
  });
});

describe.each(Object.keys(HELD_DELETE_ROUTES))('1. %s', (key) => {
  const kind = HELD_DELETE_ROUTES[key]!.kind;

  it('policy [delete]: the credential\'s call is STAGED (202 pending_approval), nothing is deleted, and the card names the agent and the run', async () => {
    await setPolicy(['delete']);
    const fx = await FIXTURES[key]!();
    const res = await w.as(w.credential, fx.method, fx.url, fx.body);
    expect(res.statusCode, `the premise: ${res.body}`).toBe(202);
    expect(res.json()).toMatchObject({ pending_approval: true });
    expect(await fx.alive(), 'nothing was deleted').toBe(true);

    const rows = await approvalRows(kind);
    const row = rows.find((r) => r.id === res.json().approval_id);
    expect(row, 'the approval row exists').toBeTruthy();
    expect(row!.status).toBe('pending');
    expect(row!.preview_text, 'names the agent').toContain('Del1178 bot');
    expect(row!.preview_text, 'names the run').toMatch(/run/i);
    expect(row!.action_snapshot.ctx.origin).toMatchObject({ agentId: w.agentId, agentName: 'Del1178 bot' });
  });

  it('approving it deletes exactly once, as the agent (audited with the run), and the credential cannot approve its own', async () => {
    await setPolicy(['delete']);
    const fx = await FIXTURES[key]!();
    const res = await w.as(w.credential, fx.method, fx.url, fx.body);
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json().approval_id as string;

    expect((await w.as(w.credential, 'POST', `${base()}/approvals/${id}/approve`)).statusCode, 'an agent can never approve its own').toBe(403);
    expect((await w.as(otherMember.token, 'POST', `${base()}/approvals/${id}/approve`)).statusCode, 'a member who is not the approver').toBeGreaterThanOrEqual(403);
    expect(await fx.alive()).toBe(true);

    const ok = await w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/approve`);
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    await settle();
    expect(await fx.alive(), 'deleted after approval').toBe(false);
    // a second approval is an idempotent no-op: the delete is not run twice
    const again = await w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/approve`);
    expect(again.statusCode).toBeLessThan(300);
    await settle();
    expect(await count("select count(*)::int as n from automation_jobs where approval_id = $1", [id]), 'one job for one approval').toBe(1);
  });

  it('declining leaves the data', async () => {
    await setPolicy(['delete']);
    const fx = await FIXTURES[key]!();
    const res = await w.as(w.credential, fx.method, fx.url, fx.body);
    const id = res.json().approval_id as string;
    expect((await w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/reject`, { reason: 'no' })).statusCode).toBeLessThan(300);
    await settle();
    expect(await fx.alive(), 'still there').toBe(true);
  });

  it('no delete policy: the credential\'s call is performed as before (the role and scope decide)', async () => {
    await setPolicy([]);
    const fx = await FIXTURES[key]!();
    const res = await w.as(w.credential, fx.method, fx.url, fx.body);
    expect(res.statusCode, res.body).toBe(fx.doneStatus);
    expect(await fx.alive(), 'deleted').toBe(false);
  });

  it('a policy that does not list delete ([email, outward]) does not hold it', async () => {
    await setPolicy(['email', 'outward']);
    const fx = await FIXTURES[key]!();
    const res = await w.as(w.credential, fx.method, fx.url, fx.body);
    expect(res.statusCode, res.body).toBe(fx.doneStatus);
    expect(await fx.alive()).toBe(false);
  });

  it('a person (the owner at the keyboard, an admin) is never staged, whatever the agent\'s policy says', async () => {
    await setPolicy(['delete']);
    for (const who of FIXTURE_DELETERS(key)) {
      const fx = await FIXTURES[key]!();
      const res = await w.as(who === 'admin' ? w.admin.token : w.owner.token, fx.method, fx.url, fx.body);
      expect(res.statusCode, `${who}: ${res.body}`).toBe(fx.doneStatus);
      expect(await fx.alive(), `the ${who} deleted it`).toBe(false);
    }
  });

  it('a guest cannot use the route to reach what they cannot delete (still refused, never staged)', async () => {
    await setPolicy(['delete']);
    const fx = await FIXTURES[key]!();
    const before = (await approvalRows(kind)).length;
    const res = await w.as(guest.token, fx.method, fx.url, fx.body);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(await fx.alive()).toBe(true);
    expect((await approvalRows(kind)).length, 'no approval for a refused caller').toBe(before);
  });
});

describe('2. what must keep working', () => {
  it('a plain personal access token (not a run credential) is not held, even when its owner owns an agent with the delete policy', async () => {
    await setPolicy(['delete']);
    const tok = await w.as(w.owner.token, 'POST', '/me/tokens', { name: 'plain', scope: 'write', workspace_id: w.ws });
    expect(tok.statusCode, tok.body).toBeLessThan(300);
    const pat = (tok.json().token ?? tok.json().secret) as string;
    const id = await ticket(`Pat ${randomUUID()}`);
    const res = await w.as(pat, 'DELETE', `${base()}/databases/${w.ticketsDbId}/records/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(await recordAlive(id)()).toBe(false);
  });

  it('the in-process delete of a server-run agent is not staged twice (no run credential, so no origin: its own staging in agents.service.ts is the only one)', async () => {
    await setPolicy(['delete']);
    const id = await ticket(`Server-run ${randomUUID()}`);
    const before = await count("select count(*)::int as n from approvals where workspace_id = $1", [w.ws]);
    const result = await app.get(RecordsService).softDelete(w.ws, w.ticketsDbId, id, w.owner.id, 0, 'agent');
    expect(result).toEqual({ deleted: true });
    expect(await count("select count(*)::int as n from approvals where workspace_id = $1", [w.ws]), 'no approval row').toBe(before);
  });

  it('a delete gate the manager declared (#542) still holds the credential, and the agent\'s policy does not stage a SECOND approval', async () => {
    await setPolicy(['delete']);
    const gate = await w.as(w.admin.token, 'POST', `${base()}/action-gates`, { action_class: 'delete_records', database_id: w.ticketsDbId, approver_id: (await pool.query('select id from "user" where email = $1', [w.admin.email])).rows[0].id });
    expect(gate.statusCode, gate.body).toBe(201);
    try {
      const id = await ticket(`Both ${randomUUID()}`);
      const before = await count("select count(*)::int as n from approvals where workspace_id = $1", [w.ws]);
      const res = await w.as(w.credential, 'DELETE', `${base()}/databases/${w.ticketsDbId}/records/${id}`);
      expect(res.json()).toMatchObject({ pending_approval: true });
      expect(await recordAlive(id)()).toBe(true);
      expect(await count("select count(*)::int as n from approvals where workspace_id = $1", [w.ws]), 'exactly one approval').toBe(before + 1);
      const row = (await pool.query('select action_snapshot from approvals where id = $1', [res.json().approval_id])).rows[0];
      expect(row.action_snapshot.action.type, 'the declared gate\'s own approval').toBe('action_class_gate');
    } finally {
      await w.as(w.admin.token, 'DELETE', `${base()}/action-gates/${gate.json().id}`);
    }
  });

  it('trash and restore: an approved delete is a soft delete the record can be restored from', async () => {
    await setPolicy(['delete']);
    const id = await ticket(`Restorable ${randomUUID()}`);
    const res = await w.as(w.credential, 'DELETE', `${base()}/databases/${w.ticketsDbId}/records/${id}`);
    expect(res.statusCode).toBe(202);
    await w.as(w.admin.token, 'POST', `${base()}/approvals/${res.json().approval_id}/approve`);
    await settle();
    expect(await recordAlive(id)()).toBe(false);
    const trash = await w.as(w.admin.token, 'GET', `${base()}/databases/${w.ticketsDbId}/records/trash`);
    expect(JSON.stringify(trash.json())).toContain(id);
    const restored = await w.as(w.admin.token, 'POST', `${base()}/databases/${w.ticketsDbId}/records/${id}/restore`);
    expect(restored.statusCode, restored.body).toBeLessThan(300);
    expect(await recordAlive(id)()).toBe(true);
    const events = await pool.query("select source, agent_id, agent_name, run_id, runner_name from activity_events where record_id = $1 and type = 'record.deleted'", [id]);
    expect(events.rows, 'the delete is audited with the agent and the run').toEqual([expect.objectContaining({ source: 'agent', agent_id: w.agentId, agent_name: 'Del1178 bot', runner_name: 'audit machine' })]);
    expect(events.rows[0].run_id, 'the run').toBeTruthy();
  });

  it('a held batch delete of records the agent cannot see is refused at the door, not staged', async () => {
    await setPolicy(['delete']);
    const before = await count("select count(*)::int as n from approvals where workspace_id = $1", [w.ws]);
    const res = await w.as(w.credential, 'POST', `${base()}/databases/00000000-0000-4000-8000-000000000000/records/batch-delete`, { record_ids: [randomUUID()] });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await count("select count(*)::int as n from approvals where workspace_id = $1", [w.ws])).toBe(before);
  });

  it('approving refuses an approver in another workspace (the staged ids are data, not authority)', async () => {
    await setPolicy(['delete']);
    const id = await ticket(`Cross ${randomUUID()}`);
    const res = await w.as(w.credential, 'DELETE', `${base()}/databases/${w.ticketsDbId}/records/${id}`);
    expect(res.statusCode).toBe(202);
    const outsider = await joinAs(app, w.admin.token, w.ws, 'Del1178Cross', 'member');
    const refused = await w.as(outsider.token, 'POST', `${base()}/approvals/${res.json().approval_id}/approve`);
    expect(refused.statusCode).toBeGreaterThanOrEqual(403);
    expect(await recordAlive(id)()).toBe(true);
  });
});

// ---- 3. approving or rejecting wakes the agent that caused the held action (ADR-0021 §1, ticket #1130's `approval_decided` source) ----
type WakeRow = { id: string; status: string; reason: string; record_id: string | null; source_key: string | null; context: { approval?: Record<string, unknown> } | null; coalesced_count: number };
const wakesOf = async (approvalId: string) =>
  (await pool.query('select id, status, reason, record_id, source_key, context, coalesced_count from agent_wakes where agent_id = $1 and (source_key = $2 or reasons::text like $3)', [w.agentId, `approval:${approvalId}`, `%${approvalId}%`])).rows as WakeRow[];
const heldDelete = async () => {
  await setPolicy(['delete']);
  const fx = await FIXTURES['DELETE /workspaces/:ws/databases/:db/records/:rec']!();
  const res = await w.as(w.credential, fx.method, fx.url, fx.body);
  expect(res.statusCode, res.body).toBe(202);
  return { fx, id: res.json().approval_id as string };
};

describe('3. a decided held delete wakes the agent that caused it, once', () => {
  it('approve: after the delete is applied, exactly one approval_decided wake carrying the verdict, the action kind and the target', async () => {
    const { fx, id } = await heldDelete();
    expect(await wakesOf(id), 'being held is not a wake').toHaveLength(0);
    expect((await w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/approve`)).statusCode).toBeLessThan(300);
    await settle();
    expect(await fx.alive()).toBe(false);
    const rows = await wakesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'approval_decided', status: 'queued' }); // (a repeat coalesced into an open wake keeps no source key of its own)
    expect(rows[0]!.context!.approval).toMatchObject({ id, verdict: 'approved', kind: 'record' });
    expect(rows[0]!.context!.approval!['target']).toBeTruthy();
  });

  it('reject: one wake at once, carrying rejected and the reason', async () => {
    const { id } = await heldDelete();
    expect((await w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/reject`, { reason: 'keep it' })).statusCode).toBeLessThan(300);
    const rows = await wakesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context!.approval).toMatchObject({ id, verdict: 'rejected', reason: 'keep it', kind: 'record' });
  });

  it('two held deletes on the same record approved in a row coalesce into ONE open wake', async () => {
    await setPolicy(['delete']);
    const rec = await ticket(`Coalesce ${randomUUID()}`);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await w.as(w.owner.token, 'POST', `${base()}/databases/${w.ticketsDbId}/records/${rec}/comments`, { body: [{ type: 'text', text: `c${i}` }] });
      const d = await w.as(w.credential, 'DELETE', `${base()}/databases/${w.ticketsDbId}/records/${rec}/comments/${c.json().id}`);
      expect(d.statusCode, d.body).toBe(202);
      ids.push(d.json().approval_id);
    }
    for (const id of ids) await w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/approve`);
    await settle();
    const open = (await pool.query("select id, coalesced_count from agent_wakes where agent_id = $1 and record_id = $2 and status in ('queued','claimed')", [w.agentId, rec])).rows;
    expect(open, 'one open wake for the agent and the record').toHaveLength(1);
    expect(open[0].coalesced_count).toBeGreaterThanOrEqual(1);
  });

  it('a double approve (a race) makes one wake', async () => {
    const { id } = await heldDelete();
    await Promise.all([w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/approve`), w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/approve`)]);
    await settle();
    await settle();
    expect(await wakesOf(id)).toHaveLength(1);
  });

  it('a human-origin approval wakes nobody (no agent origin): a declared #542 gate held a plain token\'s delete', async () => {
    await setPolicy([]);
    const adminId = (await pool.query('select id from "user" where email = $1', [w.admin.email])).rows[0].id as string;
    const gate = await w.as(w.admin.token, 'POST', `${base()}/action-gates`, { action_class: 'delete_records', database_id: w.ticketsDbId, approver_id: adminId });
    expect(gate.statusCode, gate.body).toBe(201);
    try {
      const tok = await w.as(w.owner.token, 'POST', '/me/tokens', { name: 'plain2', scope: 'write', workspace_id: w.ws });
      const pat = (tok.json().token ?? tok.json().secret) as string;
      const id = await ticket(`Plain ${randomUUID()}`);
      const before = await count('select count(*)::int as n from agent_wakes where workspace_id = $1', [w.ws]);
      const held = await w.as(pat, 'DELETE', `${base()}/databases/${w.ticketsDbId}/records/${id}`);
      expect(held.json()).toMatchObject({ pending_approval: true });
      expect((await w.as(w.admin.token, 'POST', `${base()}/approvals/${held.json().approval_id}/approve`)).statusCode).toBeLessThan(300);
      await settle();
      expect(await recordAlive(id)()).toBe(false);
      expect(await count('select count(*)::int as n from agent_wakes where workspace_id = $1', [w.ws]), 'no wake').toBe(before);
    } finally {
      await w.as(w.admin.token, 'DELETE', `${base()}/action-gates/${gate.json().id}`);
    }
  });

  // LAST: it unassigns the Runner for the rest of the file.
  it('an agent with no Runner assigned still gets the wake, queued', async () => {
    const { id } = await heldDelete();
    expect((await w.as(w.owner.token, 'PUT', `${base()}/runner-assignments/${w.agentId}`, { runner_id: null })).statusCode).toBe(200);
    expect((await w.as(w.admin.token, 'POST', `${base()}/approvals/${id}/reject`, { reason: 'later' })).statusCode).toBeLessThan(300);
    const rows = await wakesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('queued');
  });
});
