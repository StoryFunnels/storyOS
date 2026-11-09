import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, type Person } from './helpers/members';
import { ACTION_TARGET_REFUSAL } from '../src/automations/write-targets';

/**
 * Ticket #1050 — a role on a rule's (or button's) own database is not a role on every database its actions write into. A guest
 * who is creator on A, with nothing on B, cannot save a rule that creates records in B or updates B's records through a relation,
 * and cannot press a button that does; a person who can add records to B can. And a rule's approver must be a workspace member.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let guest: Person;
let member: Person;
let ws: string;
let dbA: string;
let dbB: string;
let relFieldOnA: string;
let recA: string;

const fx = async (token: string, method: string, url: string, payload?: unknown) => {
  const r = await call(app, token, method, url, payload);
  if (r.statusCode >= 300) throw new Error(`fixture ${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const rules = () => `/workspaces/${ws}/databases/${dbA}/automations`;
const rule = (actions: unknown[], extra: Record<string, unknown> = {}) => ({
  name: 'Cross-database rule',
  trigger: { type: 'record_created' },
  actions,
  ...extra,
});

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Targets Owner');
  ws = (await fx(owner.token, 'POST', '/workspaces', { name: 'Write targets WS' })).id;
  const space = (await fx(owner.token, 'GET', `/workspaces/${ws}/spaces`))[0].id;
  dbA = (await fx(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Guest workbench' })).id;
  dbB = (await fx(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Not the guest’s' })).id;
  const rel = await fx(owner.token, 'POST', `/workspaces/${ws}/relations`, {
    database_a_id: dbA, database_b_id: dbB, cardinality: 'many_to_many', field_a_name: 'Other',
  });
  relFieldOnA = rel.field_a.id;
  recA = (await fx(owner.token, 'POST', `/workspaces/${ws}/databases/${dbA}/records`, { values: { name: 'Row' } })).id;
  guest = await joinAs(app, owner.token, ws, 'Targets Guest', 'guest', [{ database_id: dbA, role: 'creator' }]);
  member = await joinAs(app, owner.token, ws, 'Targets Member', 'member');
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('#1050 rules: the saver must be able to add records where the actions write', () => {
  it('a guest cannot save create_record or create_records into a database they cannot reach', async () => {
    for (const action of [
      { type: 'create_record', database_id: dbB, values: { name: 'x' } },
      { type: 'create_records', database_id: dbB, count: 2, values: { name: 'x {index}' } },
    ]) {
      const res = await call(app, guest.token, 'POST', rules(), rule([action]));
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toContain(ACTION_TARGET_REFUSAL);
    }
  });

  it('a guest cannot save update_linked into the far side of a relation they cannot reach', async () => {
    const res = await call(app, guest.token, 'POST', rules(), rule([{ type: 'update_linked', relation_field_id: relFieldOnA, values: { name: 'x' } }]));
    expect(res.statusCode, res.body).toBe(403);
  });

  it('a missing database gets the same refusal as an unreachable one', async () => {
    const res = await call(app, guest.token, 'POST', rules(), rule([{ type: 'create_record', database_id: '00000000-0000-4000-8000-000000000000', values: {} }]));
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(ACTION_TARGET_REFUSAL);
  });

  it('the same guest can still save a rule that writes into their own database', async () => {
    const res = await call(app, guest.token, 'POST', rules(), rule([{ type: 'create_record', database_id: dbA, values: { name: 'x' } }]));
    expect(res.statusCode, res.body).toBe(201);
    const patched = await call(app, guest.token, 'PATCH', `${rules()}/${res.json().id}`, {
      actions: [{ type: 'create_record', database_id: dbB, values: { name: 'x' } }],
    });
    expect(patched.statusCode, patched.body).toBe(403);
    // A patch that does not touch the actions is not re-judged.
    const renamed = await call(app, guest.token, 'PATCH', `${rules()}/${res.json().id}`, { name: 'Renamed' });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('a member who can add records to the target saves the cross-database rule', async () => {
    const res = await call(app, owner.token, 'POST', rules(), rule([
      { type: 'create_record', database_id: dbB, values: { name: 'x' } },
      { type: 'update_linked', relation_field_id: relFieldOnA, values: { name: 'x' } },
    ]));
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('#1050 buttons: the presser must be able to add records where the actions write', () => {
  let button: string;
  beforeAll(async () => {
    button = (await fx(owner.token, 'POST', `/workspaces/${ws}/databases/${dbA}/fields`, {
      display_name: 'Log to B', type: 'button',
      config: { actions: [{ type: 'create_record', database_id: dbB, values: { name: 'From A' } }] },
    })).id;
  });

  it('a guest with editor on A cannot press a button that writes into B', async () => {
    const res = await call(app, guest.token, 'POST', `/workspaces/${ws}/databases/${dbA}/records/${recA}/buttons/${button}/press`);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(ACTION_TARGET_REFUSAL);
    const inB = await fx(owner.token, 'GET', `/workspaces/${ws}/databases/${dbB}/records`);
    expect(inB.data.some((r: { values: { name: string } }) => r.values.name === 'From A')).toBe(false);
  });

  it('the owner presses the same button and the record lands in B', async () => {
    const res = await call(app, owner.token, 'POST', `/workspaces/${ws}/databases/${dbA}/records/${recA}/buttons/${button}/press`);
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('#1050 approver_id must be an active member of the workspace', () => {
  it('an id that is not a member is refused, on create and on update', async () => {
    const created = await call(app, owner.token, 'POST', rules(), rule([{ type: 'add_comment', body_template: 'hi' }], { approverId: 'not-a-member' }));
    expect(created.statusCode, created.body).toBe(422);
    const ok = await call(app, owner.token, 'POST', rules(), rule([{ type: 'add_comment', body_template: 'hi' }]));
    const patched = await call(app, owner.token, 'PATCH', `${rules()}/${ok.json().id}`, { approverId: 'not-a-member' });
    expect(patched.statusCode, patched.body).toBe(422);
  });

  it('a workspace member is accepted', async () => {
    const res = await call(app, owner.token, 'POST', rules(), rule([{ type: 'add_comment', body_template: 'hi' }], { approverId: member.id }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().approverId).toBe(member.id);
  });
});
