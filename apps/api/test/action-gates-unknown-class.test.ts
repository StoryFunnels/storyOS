import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { actionGatePolicies, approvals, user } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';
import { ENFORCED_POLICY_CLASSES, type EnforcedPolicyClass } from '../src/action-gates/action-gates.service';

/**
 * #878 — an admin could declare a gate on "delete_database" (or anything), see it listed as
 * enabled, and nothing was ever enforced. Only classes the server actually checks may be declared,
 * and a stored policy on any other class is kept but never presented as enabled.
 */
let app: NestFastifyApplication;
let db: Db;
let tokens: TokensService;
let admin: { token: string; email: string };
let adminId: string;
let ws: string;
let space: string;
let dbId: string;

const inject = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
const declare = (action_class: string, extra: Record<string, unknown> = {}) =>
  inject('POST', `/workspaces/${ws}/action-gates`, { action_class, approver_id: adminId, ...extra });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  tokens = app.get(TokensService);
  admin = await signUpUser(app, 'Gate878');
  ws = (await inject('POST', '/workspaces', { name: 'Gate 878' })).json().id;
  space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Things' })).json().id;
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#878 declaring a gate on a class nothing enforces', () => {
  it.each(['delete_database', 'totally_made_up', 'publish_externally', 'source_push', 'DELETE_RECORDS', ' delete_records'])(
    '%s is refused with a 422 that names it and lists what IS supported',
    async (name) => {
      const res = await declare(name);
      expect(res.statusCode, res.body).toBe(422);
      const message = res.json().error.message as string;
      expect(message).toContain(`"${name}"`);
      expect(message).toContain('delete_records');
      const rows = await db.query.actionGatePolicies.findMany({ where: eq(actionGatePolicies.workspaceId, ws) });
      expect(rows.some((r) => r.actionClass === name)).toBe(false);
    },
  );

  it('delete_records still declares, at every scope (MUST KEEP WORKING)', async () => {
    for (const extra of [{}, { space_id: space }, { database_id: dbId }]) {
      const res = await declare('delete_records', extra);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().enabled).toBe(true);
      expect(res.json().enforced).toBe(true);
      expect(res.json().inert_reason).toBeNull();
    }
  });

  it('the allowlist IS the registry: every registered class is accepted, and the message lists exactly them', async () => {
    for (const cls of Object.keys(ENFORCED_POLICY_CLASSES)) {
      expect((await declare(cls)).statusCode).toBe(201);
    }
    const refused = await declare('nope');
    expect(refused.json().error.message).toContain(`Supported classes: ${Object.keys(ENFORCED_POLICY_CLASSES).join(', ')}.`);
  });
});

describe('#878 a policy stored before the check existed', () => {
  let inertId: string;
  beforeAll(async () => {
    const [row] = await db
      .insert(actionGatePolicies)
      .values({ workspaceId: ws, actionClass: 'delete_database', approverId: adminId, createdBy: adminId })
      .returning();
    inertId = row!.id;
  });

  it('is KEPT, and GET stops presenting it as enabled', async () => {
    const list = (await inject('GET', `/workspaces/${ws}/action-gates`)).json().data as Array<Record<string, unknown>>;
    const inert = list.find((p) => p.id === inertId)!;
    expect(inert, 'the row must still be there').toBeDefined();
    expect(inert.enabled).toBe(false);
    expect(inert.enforced).toBe(false);
    expect(String(inert.inert_reason)).toContain('protect nothing');
    // and a real policy in the same listing is unaffected
    expect(list.find((p) => p.action_class === 'delete_records')!.enabled).toBe(true);
  });

  it('can be disabled or deleted, never switched on', async () => {
    const on = await inject('PATCH', `/workspaces/${ws}/action-gates/${inertId}`, { enabled: true });
    expect(on.statusCode, on.body).toBe(422);
    expect((await inject('PATCH', `/workspaces/${ws}/action-gates/${inertId}`, { enabled: false })).statusCode).toBe(200);
    expect((await inject('DELETE', `/workspaces/${ws}/action-gates/${inertId}`)).statusCode).toBe(200);
  });
});

/**
 * One proof per REGISTERED class. The key sets must match (asserted below, at run time), so the
 * allowlist cannot grow ahead of the enforcement behind it: registering a class without writing
 * its proof goes red. The `satisfies` is a convenience for editors only; the API's `tsc` covers
 * `src`, not `test`, so it enforces nothing in CI.
 */
const ENFORCEMENT_PROOFS = {
  delete_records: async () => {
    // an agent-sourced delete is HELD (an approval is created, the record survives)…
    const agent = (await tokens.create(adminId, ws, `agent-${randomUUID()}`, 'admin', true, 'agent')).token;
    const rec = (await inject('POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: 'keep me' } })).json().id as string;
    const del = await inject('DELETE', `/workspaces/${ws}/databases/${dbId}/records/${rec}`, undefined, agent);
    expect(del.statusCode, del.body).toBeLessThan(300);
    const held = await db.query.approvals.findMany({ where: eq(approvals.workspaceId, ws) });
    expect(held.some((a) => JSON.stringify(a.actionSnapshot).includes(rec))).toBe(true);
    expect((await inject('GET', `/workspaces/${ws}/databases/${dbId}/records/${rec}`)).statusCode).toBe(200);
  },
} satisfies Record<EnforcedPolicyClass, () => Promise<void>>;

describe('#878 every registered class is actually enforced', () => {
  it('the proof table covers EXACTLY the registered classes', () => {
    expect(Object.keys(ENFORCEMENT_PROOFS).sort()).toEqual(Object.keys(ENFORCED_POLICY_CLASSES).sort());
  });

  for (const [cls, proof] of Object.entries(ENFORCEMENT_PROOFS)) {
    it(`${cls}: declared, then the action by an agent is held rather than performed`, async () => {
      const res = await declare(cls);
      expect(res.statusCode, res.body).toBe(201);
      await proof();
    });
  }

  it('declaring on an unsupported class is refused AT DECLARATION, so there is no false guarantee to discover at action time', async () => {
    expect((await declare('delete_database')).statusCode).toBe(422);
    const gates = (await inject('GET', `/workspaces/${ws}/action-gates`)).json().data as Array<{ action_class: string; enabled: boolean }>;
    expect(gates.filter((g) => g.action_class === 'delete_database' && g.enabled)).toEqual([]);
  });
});
