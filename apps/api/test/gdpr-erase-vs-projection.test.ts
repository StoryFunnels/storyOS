import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { DB } from '../src/db/db.module';
import { authed, signUpUser } from './helpers/users';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';
import { MembersDbService } from '../src/members/members-db.service';

/**
 * Erase vs. an in-flight Members projection.
 *
 * Accepting an invite fires `syncMembership` off the membership-event bus. It reads the membership, then the `user` row, then writes
 * the Members row. A self-erase that lands BETWEEN the reads and the write must not leave the erased person's old identifier in a
 * freshly written Members row: `eraseEverywhere` ran while no row existed yet, so it had nothing to overwrite.
 *
 * The ordering is forced, never raced: a gate sits on `roleOptionIds`, the call `syncMembership` makes AFTER it has read the user's
 * real name and email and BEFORE it writes. The test erases while the projection is parked there, then releases it.
 */
let app: NestFastifyApplication;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
const rawRows = async (q: string, p: unknown[] = []) =>
  (await (app.get(DB) as unknown as { $client: { query: (q: string, p: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }).$client.query(q, p)).rows;
const projection = () => app.get(MembersProjectionSubscriber);

const MEMBERS_ROWS = `select r.title, r.values::text v from records r join databases d on d.id = r.database_id where d.workspace_id = $1 and d.is_system and d.system_key = 'members'`;

/** Every Members row in the workspace, as text: title + values. */
const membersText = async (ws: string) => (await rawRows(MEMBERS_ROWS, [ws])).map((r) => `${String(r.title)} ${String(r.v)}`);

/**
 * Parks the NEXT call to a projection step until `release()`; resolves `parked` once it is there.
 * `roleOptionIds` runs after the projection has read the user and before it writes; `ensureMembersDb` runs before it reads the user.
 */
function gateProjection(step: 'roleOptionIds' | 'ensureMembersDb' = 'roleOptionIds') {
  let release!: () => void;
  let entered!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const parked = new Promise<void>((r) => (entered = r));
  const proto = MembersDbService.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = proto[step]!;
  let used = false;
  const spy = vi.spyOn(proto, step).mockImplementation(async function (this: unknown, ...args: unknown[]) {
    if (!used) {
      used = true;
      entered();
      await open;
    }
    return original.apply(this, args);
  } as never);
  return { parked, release, restore: () => spy.mockRestore() };
}

async function setup(label: string) {
  const boss = await signUpUser(app, `Boss ${label}`);
  const uniqueName = `Ottoline Quillfeather ${label} ${Date.now()}`;
  const person = await signUpUser(app, uniqueName);
  const ws = (await as(boss.token, 'POST', '/workspaces', { name: `Race WS ${label}` })).json().id as string;
  // The boss's own projection provisions the Members database; drain it so the gate below catches the PERSON's projection only.
  await projection().settle(ws);
  const inv = await as(boss.token, 'POST', `/workspaces/${ws}/invites`, { email: person.email, role: 'member' });
  const token = new URL(inv.json().accept_url).searchParams.get('token')!;
  return { boss, person, uniqueName, ws, token };
}

beforeAll(async () => {
  app = await createTestApp();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app.close();
});

describe('self-erase landing while an invite-accept projection is in flight', () => {
  it('leaves no old email or name in a Members row written after the erase', async () => {
    const { person, uniqueName, ws, token } = await setup('accept-then-erase');
    const gate = gateProjection();
    try {
      expect((await as(person.token, 'POST', '/invites/accept', { token })).statusCode).toBeLessThan(300);
      await gate.parked; // projection has read the real name + email and is about to write
      const res = await as(person.token, 'POST', '/me/gdpr/erase', { confirm: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().removed.members_rows_erased ?? 0, 'precondition: the erase found no row to overwrite yet').toBe(0);
    } finally {
      gate.release();
    }
    await projection().settle(ws);
    const text = (await membersText(ws)).join('\n').toLowerCase();
    expect(text, 'old email in a Members row').not.toContain(person.email.toLowerCase());
    expect(text, 'old name in a Members row').not.toContain(uniqueName.toLowerCase());
  });

  it('the erased person gets no ACTIVE Members row', async () => {
    const { person, ws, token } = await setup('active-ghost');
    const gate = gateProjection();
    try {
      await as(person.token, 'POST', '/invites/accept', { token });
      await gate.parked;
      expect((await as(person.token, 'POST', '/me/gdpr/erase', { confirm: true })).statusCode).toBe(200);
    } finally {
      gate.release();
    }
    await projection().settle(ws);
    const rows = await rawRows(MEMBERS_ROWS, [ws]);
    // Only the boss is a live member; nobody else may read as active.
    const active = rows.filter((r) => /"[^"]*":\s*true/.test(String(r.v)));
    expect(active).toHaveLength(1);
  });
});

describe('self-erase landing before the projection has read the user', () => {
  it('writes no Members row for the erased person at all', async () => {
    const { person, uniqueName, ws, token } = await setup('erase-before-read');
    const gate = gateProjection('ensureMembersDb'); // membership already read; the user row not yet
    try {
      await as(person.token, 'POST', '/invites/accept', { token });
      await gate.parked;
      expect((await as(person.token, 'POST', '/me/gdpr/erase', { confirm: true })).statusCode).toBe(200);
    } finally {
      gate.release();
    }
    await projection().settle(ws);
    const rows = await membersText(ws);
    expect(rows.join('\n').toLowerCase()).not.toContain(uniqueName.toLowerCase());
    expect(rows, 'only the boss has a Members row; the erased person was never projected').toHaveLength(1);
  });
});

describe('what must be KEPT', () => {
  it('a normal accept still projects the person into Members, active, with their real name and email', async () => {
    const { person, uniqueName, ws, token } = await setup('keep-accept');
    expect((await as(person.token, 'POST', '/invites/accept', { token })).statusCode).toBeLessThan(300);
    await projection().settle(ws);
    const text = (await membersText(ws)).join('\n');
    expect(text).toContain(person.email.toLowerCase());
    expect(text).toContain(uniqueName);
  });

  it('a normal erase (projection already settled) still scrubs the row', async () => {
    const { person, uniqueName, ws, token } = await setup('keep-erase');
    await as(person.token, 'POST', '/invites/accept', { token });
    await projection().settle(ws);
    expect((await membersText(ws)).join('\n')).toContain(person.email.toLowerCase());
    const res = await as(person.token, 'POST', '/me/gdpr/erase', { confirm: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().removed.members_rows_erased).toBeGreaterThan(0);
    await projection().settle(ws);
    const text = (await membersText(ws)).join('\n').toLowerCase();
    expect(text).not.toContain(person.email.toLowerCase());
    expect(text).not.toContain(uniqueName.toLowerCase());
  });
});
