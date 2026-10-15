import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { connections, memberships } from '../src/db/schema';
import { seal } from '../src/common/secretbox';

/**
 * The Google Calendar bindings list and the calendars list had no role gate: any signed-in person in the workspace,
 * a GUEST included, could read which databases are synced to which calendar (database name, space name, field names,
 * connection name, last error). The write routes were already admin-only; the two reads were not.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let guest: { token: string; email: string };
let member: { token: string; email: string };
let ws: string;
let connectionId: string;
const SECRET_DB = 'Confidential Payroll Calendar';

const inject = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Cal Owner');
  guest = await signUpUser(app, 'Cal Guest');
  member = await signUpUser(app, 'Cal Member');
  ws = (await inject(owner.token, 'POST', '/workspaces', { name: 'Cal Access WS' })).json().id;
  const spaces = (await inject(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json();
  const other = (await inject(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Open space' })).json().id;
  const tpl = await inject(owner.token, 'POST', `/workspaces/${ws}/templates/calendar/apply`, { space_id: spaces[0].id, include_samples: false });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const databaseId = tpl.json().databases.calendar as string;
  const fields = tpl.json().fields as Record<string, string>;
  await inject(owner.token, 'PATCH', `/workspaces/${ws}/databases/${databaseId}`, { name: SECRET_DB });
  const db = app.get(DB) as Db;
  const [conn] = await db
    .insert(connections)
    .values({
      workspaceId: ws, provider: 'google-calendar', name: 'Finance calendar account', authSealed: seal(JSON.stringify({ access_token: 't' })),
      scopes: ['https://www.googleapis.com/auth/calendar'], status: 'active',
      createdBy: (await db.query.memberships.findFirst({ where: eq(memberships.workspaceId, ws) }))?.userId,
    })
    .returning();
  connectionId = conn!.id;
  const binding = await inject(owner.token, 'POST', `/workspaces/${ws}/integrations/google-calendar/bindings`, {
    connection_id: connectionId, database_id: databaseId, calendar_id: 'primary', calendar_name: 'Payroll', start_field_id: fields['calendar.start'], direction: 'push',
  });
  expect(binding.statusCode, binding.body).toBe(201);

  for (const [u, role, grants] of [[guest, 'guest', [{ space_id: other, role: 'viewer' }]], [member, 'member', undefined]] as const) {
    const inv = await inject(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: u.email, role, ...(grants ? { grants } : {}) });
    expect(inv.statusCode, inv.body).toBe(201);
    const ok = await inject(u.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    expect(ok.statusCode, ok.body).toBe(201);
  }
}, 240_000);
afterAll(async () => { await app.close(); });

describe('google calendar reads are admin-only', () => {
  it('a guest with NO grant on the synced database cannot list the bindings, and the body names nothing', async () => {
    const res = await inject(guest.token, 'GET', `/workspaces/${ws}/integrations/google-calendar/bindings`);
    expect(res.statusCode, `served: ${res.body}`).toBe(403);
    for (const needle of [SECRET_DB, 'Finance calendar account', 'Payroll']) expect(res.body).not.toContain(needle);
  });

  it('a member cannot list them either (an integration setting, like the write routes)', async () => {
    expect((await inject(member.token, 'GET', `/workspaces/${ws}/integrations/google-calendar/bindings`)).statusCode).toBe(403);
  });

  it('the calendars list of a connection is admin-only too', async () => {
    for (const who of [guest, member]) {
      const res = await inject(who.token, 'GET', `/workspaces/${ws}/integrations/google-calendar/calendars?connection_id=${connectionId}`);
      expect(res.statusCode, res.body).toBe(403);
    }
  });

  it('MUST KEEP WORKING: an admin still lists the bindings and sees the database name', async () => {
    const res = await inject(owner.token, 'GET', `/workspaces/${ws}/integrations/google-calendar/bindings`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data[0]).toMatchObject({ database_name: SECRET_DB, calendar_name: 'Payroll' });
  });
});
