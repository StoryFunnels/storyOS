import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #368 — `space_documents.folder_id` was added by MN-096 and then never
 * returned by the API or rendered by the sidebar. The column has been dead since
 * the day it shipped.
 *
 * That dead column did real damage: because the schema advertised the
 * capability, #347's ticket AND the merged ADR both asserted documents were
 * already foldered, and #347 was scoped on that false premise.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let spaceId: string;
let otherSpaceId: string;
let docId: string;

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Folders');
  wsId = (await as('POST', '/workspaces', { name: 'Doc Folders WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  otherSpaceId = (await as('POST', `/workspaces/${wsId}/spaces`, { name: 'Elsewhere' })).json().id;
  docId = (await as('POST', `/workspaces/${wsId}/spaces/${spaceId}/documents`, { title: 'Brief' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('documents in sidebar folders (#368)', () => {
  it('the list returns folder_id at all — it never used to', async () => {
    const res = await as('GET', `/workspaces/${wsId}/spaces/${spaceId}/documents`);
    expect(res.statusCode).toBe(200);
    const doc = (res.json().data as Array<Record<string, unknown>>).find((d) => d.id === docId)!;
    // The whole bug: this key was absent, so the sidebar could never place a
    // document anywhere even though the column existed.
    expect(doc).toHaveProperty('folder_id');
    expect(doc.folder_id).toBeNull();
  });

  it('files a document into a folder and unfiles it again', async () => {
    const folderId = (await as('POST', `/workspaces/${wsId}/spaces/${spaceId}/folders`, { name: 'Briefs' })).json().id;

    const filed = await as('PATCH', `/workspaces/${wsId}/documents/${docId}`, { folder_id: folderId });
    expect(filed.statusCode, filed.body).toBeLessThan(300);
    const afterFile = (await as('GET', `/workspaces/${wsId}/spaces/${spaceId}/documents`)).json().data as Array<Record<string, unknown>>;
    expect(afterFile.find((d) => d.id === docId)!.folder_id).toBe(folderId);

    // Explicit null unfiles. `undefined` must NOT — they are different
    // operations, the same distinction views got in #347.
    await as('PATCH', `/workspaces/${wsId}/documents/${docId}`, { title: 'Brief renamed' });
    const afterRename = (await as('GET', `/workspaces/${wsId}/spaces/${spaceId}/documents`)).json().data as Array<Record<string, unknown>>;
    expect(afterRename.find((d) => d.id === docId)!.folder_id, 'a rename must not unfile it').toBe(folderId);

    await as('PATCH', `/workspaces/${wsId}/documents/${docId}`, { folder_id: null });
    const afterUnfile = (await as('GET', `/workspaces/${wsId}/spaces/${spaceId}/documents`)).json().data as Array<Record<string, unknown>>;
    expect(afterUnfile.find((d) => d.id === docId)!.folder_id).toBeNull();
  });

  it('REFUSES a folder from a different space', async () => {
    // Without this the document renders under a sidebar it does not belong to,
    // and nothing in the schema catches it.
    const foreign = (await as('POST', `/workspaces/${wsId}/spaces/${otherSpaceId}/folders`, { name: 'Foreign' })).json().id;
    const res = await as('PATCH', `/workspaces/${wsId}/documents/${docId}`, { folder_id: foreign });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/different space/i);
  });
});
