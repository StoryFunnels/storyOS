import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Readable } from 'node:stream';
import { MembersDbService } from '../src/members/members-db.service';
import { WorkspaceExportService } from '../src/export/workspace-export.service';
import { DB } from '../src/db/db.module';
import * as schema from '../src/db/schema';

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  // latin1 keeps every byte addressable as a character, so the uncompressed
  // zip entry FILENAMES survive intact even though the entry bodies are deflated.
  return Buffer.concat(chunks).toString('latin1');
}

/**
 * #317 / #318 / #319 — a system database is identified by the `is_system`
 * COLUMN, never by its display name.
 *
 * The bug class these guard against is nasty and quiet. Every one of these
 * scenarios starts the same way: a user creates a perfectly ordinary database
 * and happens to call it "Members", "Agents" or "Runs". Until the flag existed,
 * that name alone was enough for the platform to treat their data as its own
 * internal plumbing.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function listDatabases(): Promise<Array<{ id: string; name: string }>> {
  return (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json();
}

/** Create an ordinary user database over HTTP, exactly as a user would. */
async function createUserDb(name: string): Promise<{ id: string; name: string }> {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
    space_id: spaceId,
    name,
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'sysflag-admin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Sys Flag Co' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app?.close();
});

describe('a user database is never a system database, whatever it is called (#318)', () => {
  it('creating one named "Members" does not flag it', async () => {
    const mine = await createUserDb('Members');
    const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${mine.id}`)).json();
    expect(detail.name).toBe('Members');
    // The decisive assertion: the name did not confer system identity.
    expect(detail.isSystem ?? false).toBe(false);
  });

  it('cannot be forged over HTTP even when the caller asks for it', async () => {
    // `createDatabaseSchema` does not carry is_system, so this is ignored
    // rather than honoured — a user must not be able to mint a system database.
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: spaceId,
      name: 'Sneaky',
      is_system: true,
    });
    const created = res.json();
    const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${created.id}`)).json();
    expect(detail.isSystem ?? false).toBe(false);
  });

  it('does not hijack the Members projection — the real one is provisioned separately', async () => {
    // The user's "Members" already exists (first test). Provisioning the real
    // projection now must NOT adopt it: under the old name-based lookup this
    // returned the user's database and then mutated its schema.
    const service = app.get(MembersDbService);
    const projection = await service.ensureMembersDb(wsId);

    const all = await listDatabases();
    const named = all.filter((d) => d.name === 'Members');
    expect(named.length).toBe(2); // the user's, and the projection

    const mine = named.find((d) => d.id !== projection.id)!;
    const mineDetail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${mine.id}`)).json();

    // The user's database keeps the plain shape it was created with — the
    // projection did not graft User ID / Email / Avatar / Active onto it.
    const apiNames = mineDetail.fields.map((f: { apiName: string }) => f.apiName);
    expect(apiNames).not.toContain('user_id');
    expect(apiNames).not.toContain('avatar');
    // ...and no colleague's personal data was written into it.
    const rows = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${mine.id}/records`)).json();
    expect(rows.data).toHaveLength(0);
  });

  it('resolves the projection stably across repeated calls', async () => {
    const service = app.get(MembersDbService);
    const first = await service.ensureMembersDb(wsId);
    const second = await service.ensureMembersDb(wsId);
    // Idempotent: never provisions a second projection, never drifts to the
    // user's same-named database.
    expect(second.id).toBe(first.id);
    expect((await listDatabases()).filter((d) => d.name === 'Members').length).toBe(2);
  });
});

describe('workspace export keeps a user database that shares a system name (#317)', () => {
  it('exports "Members"/"Runs" the user created, and omits the real projection', async () => {
    await createUserDb('Runs');
    const service = app.get(MembersDbService);
    const projection = await service.ensureMembersDb(wsId);

    // The archive is a zip STREAM whose entries are DEFLATED, so record bytes
    // are not greppable — but zip stores each entry's FILENAME uncompressed in
    // its local header, and the export names one entry per database as
    // `spaces/<space>/<api_slug>.json`. Those names are the reliable signal for
    // "did this database make it into the archive".
    const { archive } = await app.get(WorkspaceExportService).streamExport(wsId);
    const raw = await streamToString(archive);
    const entryFor = async (id: string) => {
      const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${id}`)).json();
      return `${detail.apiSlug}.json`;
    };

    // The user's own databases survive the export — this is the #317 bug: their
    // data silently vanished from their own archive because of its name.
    const all = await listDatabases();
    const userOwned = all.filter((d) => d.id !== projection.id && ['Members', 'Runs'].includes(d.name));
    expect(userOwned.length).toBeGreaterThan(0);
    for (const db of userOwned) {
      expect(raw).toContain(await entryFor(db.id));
    }

    // The projection itself is still excluded — it is a regenerable mirror.
    expect(raw).not.toContain(await entryFor(projection.id));
  });
});

describe('the Members projection hides its join key (#319)', () => {
  it('keeps user_id stored but out of the default table view', async () => {
    const service = app.get(MembersDbService);
    const projection = await service.ensureMembersDb(wsId);

    const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${projection.id}`)).json();
    const userId = detail.fields.find((f: { apiName: string }) => f.apiName === 'user_id');

    // Still present: findMemberRow matches on it, so deleting it would break
    // upsert and tombstoning outright.
    expect(userId).toBeDefined();

    // Read the views straight from the database — there is no list route, and
    // the invariant under test is what provisioning PERSISTED.
    const db = app.get<NodePgDatabase<typeof schema>>(DB);
    const list = await db.query.views.findMany({
      where: eq(schema.views.databaseId, projection.id),
    });
    expect(list.length).toBeGreaterThan(0);
    for (const view of list) {
      const config = (view.config ?? {}) as { hidden_field_ids?: string[] };
      expect(config.hidden_field_ids ?? []).toContain(userId.id);
    }
  });
});
