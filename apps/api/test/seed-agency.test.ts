import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed } from './helpers/users';
import { like, eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { user, workspaces } from '../src/db/schema';
import { applyAgency, type AgencyResult } from '../src/seed/agency-apply';
import { AGENT_LOGINS, STUDIO_CAST, buildAgencyData, countAgencyRecords, isoDay } from '../src/seed/agency-data';

/**
 * #1297: seed:agency builds the fake Pinewood Studio agency through the real API, and a second run
 * changes nothing. The password is a test value for the test database only.
 */
const PASSWORD = 'pinewood-test-only-password-1';
const TODAY = new Date();
const DATA = buildAgencyData(TODAY);

let app: NestFastifyApplication;
let first: AgencyResult;
let second: AgencyResult;
let wsId: string;
let ownerToken: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
async function signIn(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email', payload: { email, password: PASSWORD } });
  expect(res.statusCode, `sign in ${email}`).toBeLessThan(300);
  return res.headers['set-auth-token'] as string;
}
async function database(space: string, name: string): Promise<string> {
  const spaces = (await as(ownerToken, 'GET', `/workspaces/${wsId}/spaces`)).json() as Array<{ id: string; name: string }>;
  const spaceId = spaces.find((s) => s.name === space)!.id;
  const dbs = (await as(ownerToken, 'GET', `/workspaces/${wsId}/databases`)).json() as Array<{ id: string; name: string; space_id?: string; spaceId?: string }>;
  return dbs.find((d) => d.name === name && (d.space_id ?? d.spaceId) === spaceId)!.id;
}
async function rows(dbId: string) {
  const out: Array<{ id: string; title: string; values: Record<string, unknown> }> = [];
  let cursor: string | undefined;
  do {
    const page = (await as(ownerToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 200, cursor })).json();
    out.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}
async function snapshot() {
  const snap: Record<string, string[]> = {};
  for (const [space, name] of [['Client Work', 'Clients'], ['Client Work', 'Contacts'], ['Client Work', 'Enquiries'], ['Client Work', 'Projects'], ['Client Work', 'Tasks'], ['Client Work', 'Invoices'], ['Sales', 'Quotes'], ['Team', 'Tasks']] as const) {
    snap[`${space}/${name}`] = (await rows(await database(space, name))).map((r) => r.id).sort();
  }
  return snap;
}

beforeAll(async () => {
  app = await createTestApp();
  // The test database is shared with other files and may be reused locally: start from no Pinewood at all,
  // so "the first run created everything" is a statement about this run.
  const db = app.get<Db>(DB);
  await db.delete(workspaces).where(eq(workspaces.slug, 'pinewood-studio'));
  await db.delete(user).where(like(user.email, '%@pinewood.example'));
  first = await applyAgency(app, { password: PASSWORD, today: TODAY, approvalWaitMs: 25_000 });
  wsId = first.workspace_id;
  ownerToken = await signIn(STUDIO_CAST[0]!.email);
}, 300_000);

afterAll(async () => {
  await app.close();
});

describe('seed:agency, first run', () => {
  it('creates the workspace, the three packs and the two extra databases', () => {
    expect(first.workspace_created).toBe(true);
    expect(first.packs_installed).toBe(3);
    expect(first.databases_created).toBe(2);
  });

  it('seeds roughly eighty records across the databases, including the named clients', async () => {
    expect(first.records_created).toBe(countAgencyRecords(DATA));
    expect(first.links_created).toBe(
      [...DATA.contacts, ...DATA.projects, ...DATA.tasks, ...DATA.invoices].reduce((n, r) => n + Object.values(r.links ?? {}).flat().length, 0),
    );
    expect(countAgencyRecords(DATA)).toBeGreaterThanOrEqual(80);
    const clients = (await rows(await database('Client Work', 'Clients'))).map((r) => r.title);
    expect(clients).toHaveLength(7); // no "(sample)" rows from the packs
    expect(clients.some((t) => t.includes('(sample)'))).toBe(false);
    expect(clients).toEqual(expect.arrayContaining(['Maple Street Bakery', 'Harbor Dental', 'Kerr Plumbing']));
  });

  it('has the cast with the right roles, and one login per fleet agent', async () => {
    const members = (await as(ownerToken, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{ role: string; user: { email: string } }>;
    expect(members).toHaveLength(STUDIO_CAST.length + AGENT_LOGINS.length);
    for (const person of [...STUDIO_CAST, ...AGENT_LOGINS]) {
      const m = members.find((x) => x.user.email.toLowerCase() === person.email);
      expect(m, person.email).toBeDefined();
      expect(m!.role, person.email).toBe(person.role);
    }
    expect(new Set(AGENT_LOGINS.map((a) => a.role))).toEqual(new Set(['admin', 'member', 'guest']));
    for (const email of AGENT_LOGINS.map((a) => a.email)) expect(email).toMatch(/@pinewood\.example$/);
  });

  it('uses only reserved example domains for every email it invents', () => {
    const json = JSON.stringify(DATA) + JSON.stringify(STUDIO_CAST) + JSON.stringify(AGENT_LOGINS);
    const emails = json.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[a-z]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(20);
    for (const e of emails) expect(e, e).toMatch(/\.example$/);
  });

  it('a guest sees the client space and nothing from Sales', async () => {
    const rosa = await signIn(STUDIO_CAST.find((p) => p.key === 'rosa')!.email);
    const spaces = ((await as(rosa, 'GET', `/workspaces/${wsId}/spaces`)).json() as Array<{ name: string }>).map((s) => s.name);
    expect(spaces).toContain('Client Work');
    expect(spaces).not.toContain('Sales');
    expect(spaces).not.toContain('Team');
  });

  it('has exactly two overdue open tasks, and dates are relative to today', async () => {
    const tasks = await rows(await database('Client Work', 'Tasks'));
    const today = isoDay(TODAY, 0);
    const overdue = DATA.tasks.filter((t) => String(t.values['Due Date']) < today && t.values.State !== 'Done');
    expect(overdue).toHaveLength(2);
    expect(tasks).toHaveLength(DATA.tasks.length);
    expect(DATA.clients.every((c) => String(c.values['Client Since']) <= today)).toBe(true);
  });

  it('carries agent-written comments that the API reports as source agent', async () => {
    expect(first.agent_comments_created).toBe(DATA.agentComments.length);
    const clients = await database('Client Work', 'Clients');
    const tide = (await rows(clients)).find((r) => r.title === 'Tidewater Coffee Roasters')!;
    const list = (await as(ownerToken, 'GET', `/workspaces/${wsId}/databases/${clients}/records/${tide.id}/comments`)).json().data as Array<{ source: string; agent_name: string | null }>;
    expect(list.some((c) => c.source === 'agent' && c.agent_name === 'Brief Writer')).toBe(true);
  });

  it('has one pending approval, raised by the rule that asks', async () => {
    expect(first.approval_pending).toBe(true);
    const res = (await as(ownerToken, 'GET', `/workspaces/${wsId}/approvals?status=pending`)).json();
    const list = Array.isArray(res) ? res : res.data;
    expect(list).toHaveLength(1);
    const quotes = await database('Sales', 'Quotes');
    const rules = (await as(ownerToken, 'GET', `/workspaces/${wsId}/databases/${quotes}/automations`)).json();
    const rule = (Array.isArray(rules) ? rules : rules.data).find((r: { name: string }) => r.name === DATA.approval.ruleName);
    expect(rule, 'the gated rule exists').toBeDefined();
    expect(list[0].rule_id).toBe(rule.id);
    expect(list[0].preview_text).toContain('Harbor Dental recall campaign');
  });
});

describe('seed:agency, second run', () => {
  let before: Record<string, string[]>;
  let humanClientId: string;
  const MAPLE_VALUE = 9999;

  beforeAll(async () => {
    before = await snapshot();
    // What must be KEPT: a person's own record, and a person's edit to a seeded one.
    const clientsDb = await database('Client Work', 'Clients');
    const made = await as(ownerToken, 'POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: "Dana's own prospect" } });
    expect(made.statusCode, made.body).toBe(201);
    humanClientId = made.json().id;
    const maple = (await rows(clientsDb)).find((r) => r.title === 'Maple Street Bakery')!;
    const detail = (await as(ownerToken, 'GET', `/workspaces/${wsId}/databases/${clientsDb}`)).json() as { fields: Array<{ displayName: string; apiName: string }> };
    const valueField = detail.fields.find((f) => f.displayName === 'Monthly Value')!.apiName;
    const edit = await as(ownerToken, 'PATCH', `/workspaces/${wsId}/databases/${clientsDb}/records/${maple.id}`, { values: { [valueField]: MAPLE_VALUE } });
    expect(edit.statusCode, edit.body).toBeLessThan(300);
    second = await applyAgency(app, { password: PASSWORD, today: TODAY, approvalWaitMs: 5_000 });
  }, 300_000);

  it('creates nothing: same workspace, same records, no new people, packs or comments', async () => {
    expect(second.workspace_id).toBe(first.workspace_id);
    expect(second).toMatchObject({
      workspace_created: false, packs_installed: 0, databases_created: 0, people_created: 0, members_invited: 0,
      records_created: 0, links_created: 0, agent_comments_created: 0, approval_pending: true,
    });
    const after = await snapshot();
    const expected = { ...before, 'Client Work/Clients': [...before['Client Work/Clients']!, humanClientId].sort() };
    expect(after).toEqual(expected);
  });

  it('still has exactly one gated rule', async () => {
    const quotes = await database('Sales', 'Quotes');
    const rules = (await as(ownerToken, 'GET', `/workspaces/${wsId}/databases/${quotes}/automations`)).json();
    expect((Array.isArray(rules) ? rules : rules.data).filter((r: { name: string }) => r.name === DATA.approval.ruleName)).toHaveLength(1);
  });

  it('still has exactly one pending approval and the same members', async () => {
    const res = (await as(ownerToken, 'GET', `/workspaces/${wsId}/approvals?status=pending`)).json();
    expect(Array.isArray(res) ? res : res.data).toHaveLength(1);
    const members = (await as(ownerToken, 'GET', `/workspaces/${wsId}/members`)).json() as unknown[];
    expect(members).toHaveLength(STUDIO_CAST.length + AGENT_LOGINS.length);
  });

  it("keeps what a person did: their own record and their edit to a seeded record", async () => {
    const clientsDb = await database('Client Work', 'Clients');
    const all = await rows(clientsDb);
    expect(all.map((r) => r.title)).toContain("Dana's own prospect");
    const maple = all.find((r) => r.title === 'Maple Street Bakery')!;
    const detail = (await as(ownerToken, 'GET', `/workspaces/${wsId}/databases/${clientsDb}`)).json() as { fields: Array<{ displayName: string; apiName: string }> };
    const valueField = detail.fields.find((f) => f.displayName === 'Monthly Value')!.apiName;
    const fresh = (await as(ownerToken, 'GET', `/workspaces/${wsId}/databases/${clientsDb}/records/${maple.id}`)).json();
    expect(Number(fresh.values?.[valueField] ?? fresh[valueField])).toBe(MAPLE_VALUE);
  });
});
