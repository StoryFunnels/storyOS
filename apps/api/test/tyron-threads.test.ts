import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { TyronThreadsService } from '../src/agents/tyron/threads.service';

/**
 * Tyron threads (#359).
 *
 * The rule under test is "private to the creating member — **not visible to
 * admins**". So the fixture that matters is an ADMIN of the same workspace, not
 * another guest: the whole point of #290's no-admin-bypass decision is that the
 * role which can see everything else cannot see this. A test with two peers would
 * pass against an implementation that leaks to admins.
 *
 * `owner` here is a plain MEMBER and `admin` created the workspace, so the
 * privacy direction being asserted is the awkward one — the workspace owner
 * cannot read a member's thread.
 */
let app: NestFastifyApplication;
let db: ReturnType<typeof connectTestDb>;
let admin: { token: string; email: string };
let owner: { token: string; email: string };
let outsider: { token: string; email: string };
let wsId: string;
let ownerThread: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  db = connectTestDb();
  admin = await signUpUser(app, 'Admin');
  owner = await signUpUser(app, 'Thread Owner');
  outsider = await signUpUser(app, 'Outsider');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Tyron WS' })).json().id;

  // `owner` joins as an ordinary member — the person whose threads must stay private.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: owner.email,
    role: 'member',
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(owner.token, 'POST', '/invites/accept', { token });

  const created = await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads`, {
    first_message: 'Set up a pipeline for inbound leads',
  });
  expect(created.statusCode, created.body).toBe(201);
  ownerThread = created.json().id;
});

afterAll(async () => {
  await db.pool.end();
  await app.close();
});

describe('auto-naming (#359 — nothing is called "Untitled")', () => {
  it('names a thread from its first message', () => {
    expect(TyronThreadsService.titleFrom('Set up a pipeline for inbound leads')).toBe(
      'Set up a pipeline for inbound leads',
    );
  });

  it('uses the first non-empty LINE, so a pasted brief becomes a title not a wall', () => {
    const pasted = '\n\nClean up the client list\n\nThen archive anything older than 2024.';
    expect(TyronThreadsService.titleFrom(pasted)).toBe('Clean up the client list');
  });

  it('collapses runs of whitespace', () => {
    expect(TyronThreadsService.titleFrom('too    many     spaces')).toBe('too many spaces');
  });

  it('truncates a long opener on a word boundary', () => {
    const long =
      'Please go through every client record and check that the owner field is set correctly';
    const title = TyronThreadsService.titleFrom(long);
    expect(title.length).toBeLessThanOrEqual(61); // 60 + the ellipsis
    expect(title.endsWith('…')).toBe(true);
    // Cut between words, not mid-word.
    expect(title).not.toMatch(/\s…$/);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
  });

  it('does not truncate to almost nothing when the first word is enormous', () => {
    // A pasted URL or id has no space to break on. Falling back to a hard cut is
    // right; returning two characters because the only space was at index 3 is not.
    const url = `https://example.com/${'a'.repeat(200)}`;
    const title = TyronThreadsService.titleFrom(url);
    expect(title.length).toBeGreaterThan(40);
  });

  it('never returns an empty title', () => {
    // An attachment-only opener, or a message that is pure whitespace.
    expect(TyronThreadsService.titleFrom('')).toBe('New conversation');
    expect(TyronThreadsService.titleFrom('   \n\t  ')).toBe('New conversation');
  });
});

describe('privacy — private to the creating member, INCLUDING from admins (#359/#290)', () => {
  it('the owner can read their own thread', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/tyron/threads/${ownerThread}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().title).toBe('Set up a pipeline for inbound leads');
  });

  /**
   * The load-bearing assertion. #290 decided there is no admin bypass for
   * personal content, and this is the admin who created the workspace.
   */
  it('an ADMIN of the same workspace cannot read it', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/tyron/threads/${ownerThread}`);
    expect(res.statusCode, 'an admin must not read a member thread').toBe(404);
  });

  it('404, not 403 — a 403 would confirm the thread exists', async () => {
    // Telling someone "that thread is not yours" leaks the one fact privacy is
    // meant to withhold: that it is there at all.
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/tyron/threads/${ownerThread}`);
    expect(res.statusCode).not.toBe(403);
  });

  it("an admin's thread list does not include it", async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/tyron/threads`);
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain(ownerThread);
  });

  it('an admin cannot rename or delete it', async () => {
    const renamed = await as(admin.token, 'PATCH', `/workspaces/${wsId}/tyron/threads/${ownerThread}`, {
      title: 'Hijacked',
    });
    expect(renamed.statusCode).toBe(404);

    const deleted = await as(admin.token, 'DELETE', `/workspaces/${wsId}/tyron/threads/${ownerThread}`);
    expect(deleted.statusCode).toBe(404);

    // And neither half-applied.
    const { rows } = await db.pool.query(`SELECT title FROM tyron_threads WHERE id = $1`, [ownerThread]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Set up a pipeline for inbound leads');
  });

  it('someone outside the workspace cannot reach it at all', async () => {
    const res = await as(outsider.token, 'GET', `/workspaces/${wsId}/tyron/threads/${ownerThread}`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('the thread list', () => {
  it('is per-member and ordered most-recently-used first', async () => {
    const older = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads`, { first_message: 'Older thread' })
    ).json().id;
    const newer = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads`, { first_message: 'Newer thread' })
    ).json().id;

    const ids = (
      (await as(owner.token, 'GET', `/workspaces/${wsId}/tyron/threads`)).json().data as Array<{ id: string }>
    ).map((t) => t.id);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });
});

describe('rename and delete', () => {
  it('renames', async () => {
    const t = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads`, { first_message: 'Rename me' })
    ).json().id;
    const res = await as(owner.token, 'PATCH', `/workspaces/${wsId}/tyron/threads/${t}`, {
      title: 'A better name',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().title).toBe('A better name');
  });

  it('rejects an empty title rather than storing one', async () => {
    // The whole point of auto-naming is that no thread is nameless; a rename that
    // could blank it would undo that.
    const t = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads`, { first_message: 'Keep my name' })
    ).json().id;
    const res = await as(owner.token, 'PATCH', `/workspaces/${wsId}/tyron/threads/${t}`, { title: '   ' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('deletes the thread and its messages, and nothing else', async () => {
    const t = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads`, { first_message: 'Temporary' })
    ).json().id;
    const res = await as(owner.token, 'DELETE', `/workspaces/${wsId}/tyron/threads/${t}`);
    expect(res.statusCode, res.body).toBeLessThan(300);

    const gone = await db.pool.query(`SELECT id FROM tyron_threads WHERE id = $1`, [t]);
    expect(gone.rows).toHaveLength(0);
    const msgs = await db.pool.query(`SELECT id FROM tyron_messages WHERE thread_id = $1`, [t]);
    expect(msgs.rows, 'messages cascade').toHaveLength(0);

    // The owner's other threads are untouched — a delete is one thread, not a purge.
    const still = await as(owner.token, 'GET', `/workspaces/${wsId}/tyron/threads/${ownerThread}`);
    expect(still.statusCode).toBe(200);
  });
});

describe('structured actions (#359 → #354 replay)', () => {
  /**
   * #359 requires a thread record "sufficient for #354 to replay one later" — as
   * STRUCTURE, not prose. If the only record were the transcript, "do this every
   * Monday" would mean re-deriving intent from text, which is a rewrite rather
   * than a feature.
   */
  it('stores tool calls as data alongside the message', async () => {
    const threads = app.get(TyronThreadsService);
    const membership = { workspaceId: wsId, userId: (await as(owner.token, 'GET', '/me')).json().id } as never;

    await threads.appendMessage(membership, ownerThread, {
      role: 'assistant',
      content: 'Added a Status field to Clients.',
      actions: [{ name: 'add_field', arguments: { database: 'crm/clients', name: 'Status', type: 'select' } }],
    });

    const { rows } = await db.pool.query(
      `SELECT actions FROM tyron_messages WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ownerThread],
    );
    expect(rows[0].actions).toEqual([
      { name: 'add_field', arguments: { database: 'crm/clients', name: 'Status', type: 'select' } },
    ]);
  });

  /**
   * #357: Tyron streams outcomes and NEVER a tool trace. An API that returns the
   * structured action log invites a client to render one, so the read path must
   * not expose it even though the write path stores it.
   */
  it('does NOT return actions over the API', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/tyron/threads/${ownerThread}`);
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain('add_field');
    for (const m of res.json().messages as Array<Record<string, unknown>>) {
      expect(m).not.toHaveProperty('actions');
    }
  });

  it('defaults to an empty action list for a message that only talked', async () => {
    const threads = app.get(TyronThreadsService);
    const membership = { workspaceId: wsId, userId: (await as(owner.token, 'GET', '/me')).json().id } as never;
    await threads.appendMessage(membership, ownerThread, { role: 'user', content: 'thanks' });

    const { rows } = await db.pool.query(
      `SELECT actions FROM tyron_messages WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ownerThread],
    );
    expect(rows[0].actions).toEqual([]);
  });
});

/**
 * #357d — the confirm round-trip.
 *
 * These run against the real endpoint with no model configured, which is exactly
 * the right shape: `confirm` never calls the model. It executes a call that was
 * already classified and stored, so its behaviour is fully testable here.
 */
describe('answering Tyron\'s pending question (#357d/#358)', () => {
  let thread: string;

  beforeAll(async () => {
    thread = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads`, { first_message: 'Confirm me' })
    ).json().id;
  });

  it('says so plainly when there is nothing to answer, rather than erroring', async () => {
    // The likeliest cause is a second click or another tab. A 4xx would make an
    // ordinary race look like a fault.
    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads/${thread}/confirm`, {
      approve: true,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().reply).toMatch(/nothing waiting/i);
  });

  it('declining runs nothing and says so', async () => {
    await db.pool.query(
      `UPDATE tyron_threads SET pending_action = $1 WHERE id = $2`,
      [JSON.stringify({ name: 'delete_record', arguments: { record_ids: ['x'] }, message: 'Delete 1 record?' }), thread],
    );
    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads/${thread}/confirm`, {
      approve: false,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().reply).toMatch(/haven't done it/i);

    const { rows } = await db.pool.query(`SELECT pending_action FROM tyron_threads WHERE id = $1`, [thread]);
    expect(rows[0].pending_action, 'a declined question must not linger').toBeNull();
  });

  /**
   * The double-click guard. The pending action is cleared BEFORE the tool runs,
   * so a second click cannot execute a destructive action twice — losing it on a
   * failure is the safe direction, because the user can ask again whereas a
   * double delete cannot be taken back.
   */
  it('clears the pending action so it cannot be executed twice', async () => {
    await db.pool.query(
      `UPDATE tyron_threads SET pending_action = $1 WHERE id = $2`,
      [JSON.stringify({ name: 'delete_record', arguments: { record_ids: ['x'] }, message: 'Delete 1 record?' }), thread],
    );
    // Approve once. The tool call itself fails (no MCP in tests) but the CLEARING
    // is what this asserts, and it must happen regardless of the outcome.
    await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads/${thread}/confirm`, { approve: true });

    const { rows } = await db.pool.query(`SELECT pending_action FROM tyron_threads WHERE id = $1`, [thread]);
    expect(rows[0].pending_action).toBeNull();

    const second = await as(owner.token, 'POST', `/workspaces/${wsId}/tyron/threads/${thread}/confirm`, {
      approve: true,
    });
    expect(second.json().reply, 'the second click finds nothing to do').toMatch(/nothing waiting/i);
  });

  it("a different member cannot answer someone else's question", async () => {
    await db.pool.query(
      `UPDATE tyron_threads SET pending_action = $1 WHERE id = $2`,
      [JSON.stringify({ name: 'delete_record', arguments: {}, message: 'Delete?' }), thread],
    );
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/tyron/threads/${thread}/confirm`, {
      approve: true,
    });
    expect(res.statusCode, 'owner-scoped, like every other thread route').toBe(404);

    const { rows } = await db.pool.query(`SELECT pending_action FROM tyron_threads WHERE id = $1`, [thread]);
    expect(rows[0].pending_action, 'and it must still be pending').not.toBeNull();
  });
});
