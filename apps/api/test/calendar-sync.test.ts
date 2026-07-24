import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { connections, memberships, records as recordsTable } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { CalendarSyncService } from '../src/calendar-sync/calendar-sync.service';

let app: NestFastifyApplication;
let db: Db;
let calendar: CalendarSyncService;
let admin: { token: string; email: string };
let wsId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  calendar = app.get(CalendarSyncService);
  admin = await signUpUser(app, 'CalendarTwoWay');
  wsId = (await inject('POST', '/workspaces', { name: 'Calendar two-way WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('Google Calendar pull and two-way sync (#20)', () => {
  it('imports and removes Google events, then pushes StoryOS edits in two-way mode', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const template = await inject('POST', `/workspaces/${wsId}/templates/calendar/apply`, {
      space_id: spaceId,
      include_samples: false,
    });
    expect(template.statusCode, template.body).toBe(201);
    const databaseId = template.json().databases.calendar as string;
    const fields = template.json().fields as Record<string, string>;

    const [connection] = await db
      .insert(connections)
      .values({
        workspaceId: wsId,
        provider: 'google-calendar',
        name: 'Test Google Calendar',
        authSealed: seal(JSON.stringify({ access_token: 'calendar-test-token' })),
        scopes: ['https://www.googleapis.com/auth/calendar'],
        status: 'active',
        createdBy: (
          await db.query.memberships.findFirst({ where: eq(memberships.workspaceId, wsId) })
        )?.userId,
      })
      .returning();

    let externalStatus: 'confirmed' | 'cancelled' = 'confirmed';
    let externalSummary = 'Imported planning session';
    let externalUpdated = '2026-07-24T08:00:00.000Z';
    const outbound: Array<{ url: string; method: string; body?: string }> = [];
    calendar.fetcher = async (url, init) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/events?')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'google-event-1',
                status: externalStatus,
                summary: externalSummary,
                description: 'Created in Google',
                updated: externalUpdated,
                start: { date: '2026-07-25' },
                end: { date: '2026-07-27' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/events/') && method === 'PATCH') {
        outbound.push({ url, method, body: init?.body as string | undefined });
        return new Response(
          JSON.stringify({ id: 'google-event-1', updated: '2026-07-24T09:00:00.000Z' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected Calendar request: ${method} ${url}`);
    };

    const binding = await inject(
      'POST',
      `/workspaces/${wsId}/integrations/google-calendar/bindings`,
      {
        connection_id: connection!.id,
        database_id: databaseId,
        calendar_id: 'primary',
        calendar_name: 'Primary',
        start_field_id: fields['calendar.start'],
        end_field_id: fields['calendar.end'],
        description_field_id: fields['calendar.description'],
        direction: 'two_way',
      },
    );
    expect(binding.statusCode, binding.body).toBe(201);

    const firstSync = await inject(
      'POST',
      `/workspaces/${wsId}/integrations/google-calendar/bindings/${binding.json().id}/sync`,
    );
    expect(firstSync.statusCode, firstSync.body).toBe(201);
    expect(firstSync.json()).toEqual(
      expect.objectContaining({ pulled: 1, synced: 1, deleted: 0, conflicts: 0 }),
    );

    const records = await inject('GET', `/workspaces/${wsId}/databases/${databaseId}/records`);
    expect(records.json().data).toHaveLength(1);
    expect(records.json().data[0]).toEqual(
      expect.objectContaining({
        title: 'Imported planning session',
        values: expect.objectContaining({
          start: '2026-07-25T00:00:00.000Z',
          end: '2026-07-26T00:00:00.000Z',
        }),
      }),
    );
    expect(outbound[0]?.body).toContain('"start":{"date":"2026-07-25"}');
    expect(outbound[0]?.body).not.toContain('"start":{"dateTime"');

    outbound.length = 0;
    const recordId = records.json().data[0].id as string;
    const update = await inject(
      'PATCH',
      `/workspaces/${wsId}/databases/${databaseId}/records/${recordId}`,
      { values: { name: 'Edited in StoryOS' } },
    );
    expect(update.statusCode, update.body).toBe(200);
    await expect
      .poll(() => outbound.some((request) => request.body?.includes('Edited in StoryOS')))
      .toBe(true);

    await db
      .update(recordsTable)
      .set({ title: 'Unsynced local edit', updatedAt: new Date() })
      .where(eq(recordsTable.id, recordId));
    externalSummary = 'Newer Google edit';
    externalUpdated = '2026-07-24T10:00:00.000Z';
    const conflictSync = await inject(
      'POST',
      `/workspaces/${wsId}/integrations/google-calendar/bindings/${binding.json().id}/sync`,
    );
    expect(conflictSync.json().conflicts).toBe(1);
    const afterConflict = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${databaseId}/records`,
    );
    expect(afterConflict.json().data[0].title).toBe('Newer Google edit');

    externalStatus = 'cancelled';
    externalUpdated = '2026-07-24T12:00:00.000Z';
    const deleteSync = await inject(
      'POST',
      `/workspaces/${wsId}/integrations/google-calendar/bindings/${binding.json().id}/sync`,
    );
    expect(deleteSync.json().deleted).toBe(1);
    const afterDelete = await inject('GET', `/workspaces/${wsId}/databases/${databaseId}/records`);
    expect(afterDelete.json().data).toHaveLength(0);
  });
});
