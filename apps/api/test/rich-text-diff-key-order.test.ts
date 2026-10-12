import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { desc, eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { activityEvents } from '../src/db/schema';

/**
 * #840 — "formatting changed in 5 blocks" for a one-line edit, REAL DATABASE.
 *
 * The unit tests in block-diff.test.ts pin the pure function; this pins the
 * seam that actually failed: RecordsService.update() compares the stored value
 * (read back from a jsonb column, whose keys Postgres re-sorts) with the
 * caller's value (the writer's own key order). A plain JSON.stringify comparison
 * called every API-written block "changed". Content written by the editor
 * escaped it only because BlockNote's key order happens to match jsonb's.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
const { db, pool } = connectTestDb();
const base = () => `/api/v1/workspaces/${wsId}/databases/${dbId}/records`;

// An API-written block: no id, and nested keys in the CALLER's order — which is
// not jsonb's (jsonb sorts shortest-first: textColor, textAlignment, backgroundColor).
const callerBlock = (text: string) => ({
  type: 'paragraph',
  props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});
const lines = ['Intro', 'Second', 'Third', 'Fourth', 'Fifth'];

async function latestUpdate(recordId: string) {
  const events = await db.query.activityEvents.findMany({
    where: eq(activityEvents.recordId, recordId),
    orderBy: [desc(activityEvents.createdAt)],
  });
  return events.filter((e) => e.type === 'record.updated');
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RichDiff');
  wsId = (
    await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: authed(admin.token), payload: { name: 'RichDiff WS' } })
  ).json().id;
  const spaces = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}/spaces`, headers: authed(admin.token) });
  dbId = (
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: spaces.json()[0].id, name: 'Jobs' },
    })
  ).json().id;
  await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
    headers: authed(admin.token),
    payload: { display_name: 'About', type: 'rich_text' },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('rich_text edit diff through the real API (#840)', () => {
  it('a one-line edit of API-written, id-less content stores ONE changed block, not five', async () => {
    const created = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(admin.token),
      payload: { values: { name: 'Office Administrator', about: lines.map(callerBlock) } },
    });
    expect(created.statusCode).toBe(201);
    const recId = created.json().id;

    const edited = lines.map((t, i) => callerBlock(i === 2 ? 'Third EDITED' : t));
    const res = await app.inject({ method: 'PATCH', url: `${base()}/${recId}`, headers: authed(admin.token), payload: { values: { about: edited } } });
    expect(res.statusCode).toBe(200);

    const [update] = await latestUpdate(recId);
    const diff = (update!.payload as { diff: Record<string, { blocks?: Array<{ kind: string }> }> }).diff;
    const blocks = Object.values(diff)[0]!.blocks!;
    expect(blocks.map((b) => b.kind)).toEqual(['changed']);
  });

  it('re-saving identical content in a different key order records no change at all', async () => {
    const created = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(admin.token),
      payload: { values: { name: 'No-op', about: lines.map(callerBlock) } },
    });
    const recId = created.json().id;
    // Same content again, in the CALLER's key order. The stored side now comes back
    // from jsonb with its keys re-sorted, so a JSON.stringify comparison saw a change.
    // (Writing it in jsonb's own order would pass either way and prove nothing.)
    await app.inject({
      method: 'PATCH',
      url: `${base()}/${recId}`,
      headers: authed(admin.token),
      payload: { values: { about: lines.map(callerBlock) } },
    });
    expect(await latestUpdate(recId)).toEqual([]);
  });

  it('a real change is still recorded', async () => {
    const created = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(admin.token),
      payload: { values: { name: 'Real', about: [callerBlock('before')] } },
    });
    const recId = created.json().id;
    await app.inject({ method: 'PATCH', url: `${base()}/${recId}`, headers: authed(admin.token), payload: { values: { about: [callerBlock('after')] } } });
    expect(await latestUpdate(recId)).toHaveLength(1);
  });
});
