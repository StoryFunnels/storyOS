import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql, type SQL } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';

/**
 * #512 — backlinks() used to be a bare `.limit(100)` with no total and no
 * cursor: an 11th+ page of mentions was silently invisible. These tests seed
 * 101 backlinks directly (101 separate source records, each with one
 * `record_mentions` row against the same target) via `recordMentions` inserts
 * rather than 101 document PUTs — the paging behaviour under test lives
 * entirely in the read path, and 101 sequential `syncRecordMentions` round
 * trips would make this test needlessly slow.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let spaceId: string;
let sourcesDb: string;
let targetDb: string;
let target: string;
const sourceIds: string[] = [];

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'PagingOwner');

  ws = (await inject('POST', '/workspaces', { name: 'Backlinks Paging WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  sourcesDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Sources' })).json().id;
  targetDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Target' })).json().id;
  target = (await inject('POST', `/workspaces/${ws}/databases/${targetDb}/records`, { values: {} })).json().id;

  const { db } = connectTestDb();
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO records (database_id, title, values, position)
    SELECT ${sourcesDb}::uuid, 'source ' || i, '{}'::jsonb, 'a' || lpad(i::text, 10, '0')
    FROM generate_series(1, 101) AS i
    RETURNING id
  `);
  sourceIds.push(...created.rows.map((r) => r.id));

  const rows: SQL[] = sourceIds.map(
    (sourceId, i) => sql`(${ws}::uuid, ${sourceId}::uuid, ${target}::uuid, now() - ${`${i} seconds`}::interval)`,
  );
  await db.execute(sql`
    INSERT INTO record_mentions (workspace_id, source_record_id, target_record_id, created_at)
    VALUES ${sql.join(rows, sql`, `)}
  `);
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('backlinks pagination (#512)', () => {
  it('reports the true total on page one, not the page size', async () => {
    const res = await inject('GET', `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(101);
    expect(body.data).toHaveLength(100);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTruthy();
  });

  it('the cursor from page one returns the 101st backlink on page two, with no overlap', async () => {
    const page1 = (await inject('GET', `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks`)).json();
    const page2 = (
      await inject(
        'GET',
        `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks?cursor=${encodeURIComponent(page1.next_cursor)}`,
      )
    ).json();

    expect(page2.data).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
    expect(page2.total).toBe(101);

    const page1Ids = new Set(page1.data.map((r: { id: string }) => r.id));
    expect(page1Ids.has(page2.data[0].id)).toBe(false);
    const allIds = new Set([...page1Ids, page2.data[0].id]);
    expect(allIds.size).toBe(101);
    for (const id of sourceIds) expect(allIds.has(id)).toBe(true);
  });

  it('respects an explicit smaller limit', async () => {
    const res = await inject('GET', `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks?limit=10`);
    const body = res.json();
    expect(body.data).toHaveLength(10);
    expect(body.has_more).toBe(true);
    expect(body.total).toBe(101);
  });

  it('rejects a garbage cursor rather than silently ignoring it', async () => {
    const res = await inject('GET', `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks?cursor=not-valid-base64url-json`);
    expect(res.statusCode).toBe(422);
  });

  it("guest scoping holds on every page, not just page one", async () => {
    // grant a guest access to the target database only, not the sources database
    const guest = await signUpUser(app, 'PagingGuest');
    const invite = await inject('POST', `/workspaces/${ws}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ database_id: targetDb, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await inject('POST', '/invites/accept', { token }, guest.token);

    const page1 = await inject(
      'GET',
      `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks`,
      undefined,
      guest.token,
    );
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    // the guest can't see the Sources database at all → every backlink is filtered
    expect(body1.total).toBe(0);
    expect(body1.data).toEqual([]);
    expect(body1.has_more).toBe(false);
    expect(body1.next_cursor).toBeNull();

    // and paging past an empty page-one still holds the same scoping, not just
    // reads it once — pass the owner's real cursor as a guest and confirm the
    // guest still sees nothing on the "second page" either
    const ownerPage1 = (await inject('GET', `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks`)).json();
    const guestPage2 = await inject(
      'GET',
      `/workspaces/${ws}/databases/${targetDb}/records/${target}/backlinks?cursor=${encodeURIComponent(ownerPage1.next_cursor)}`,
      undefined,
      guest.token,
    );
    expect(guestPage2.statusCode).toBe(200);
    expect(guestPage2.json().data).toEqual([]);
  });

  it('an empty backlink set returns cleanly (no mentions at all)', async () => {
    const lonely = (await inject('POST', `/workspaces/${ws}/databases/${targetDb}/records`, { values: {} })).json().id;
    const res = await inject('GET', `/workspaces/${ws}/databases/${targetDb}/records/${lonely}/backlinks`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], total: 0, has_more: false, next_cursor: null });
  });
});
