import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #677 (Gap 2) — real version history for a record's document (BlockNote
 * description). `documents.version` is an optimistic-concurrency counter
 * (PUT with a stale expected_version -> 409), not a history — this ticket
 * adds the actual history: a new `document_versions` table, captured on
 * every edit past the first, previewable as a block-level diff (reusing
 * #595's `diffBlocks`), and restorable (itself reversible).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

const docUrl = (rec: string) => `/workspaces/${wsId}/databases/${dbId}/records/${rec}/document`;
const blocknote = (text: string) => [{ id: 'b1', type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'DocVersionWriter');
  wsId = (await inject('POST', '/workspaces', { name: '677g2 WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Articles' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#677 — document version history', () => {
  it('the FIRST save captures no version (nothing existed before it)', async () => {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'R1' } })).json();
    const put = await inject('PUT', docUrl(rec.id), { content: blocknote('v1'), expected_version: 0 });
    expect(put.statusCode, put.body).toBeLessThan(300);

    const versions = (await inject('GET', `${docUrl(rec.id)}/versions`)).json();
    expect(versions.data).toEqual([]);
  });

  it('editing again produces a restorable version — AC #4, reproduced live', async () => {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'R2' } })).json();
    await inject('PUT', docUrl(rec.id), { content: blocknote('first'), expected_version: 0 });
    const second = await inject('PUT', docUrl(rec.id), { content: blocknote('second'), expected_version: 1 });
    expect(second.statusCode, second.body).toBeLessThan(300);

    const versions = (await inject('GET', `${docUrl(rec.id)}/versions`)).json();
    // Exactly one version: the pre-second-edit ("first") content, captured before the overwrite.
    expect(versions.data).toHaveLength(1);
    expect(versions.data[0].version).toBe(1); // the document's own version counter AT that snapshot
    expect(versions.data[0].source).toBe('human');

    // A third edit produces a second restorable version — TWO restorable versions total, matching AC #4 exactly.
    const third = await inject('PUT', docUrl(rec.id), { content: blocknote('third'), expected_version: 2 });
    expect(third.statusCode, third.body).toBeLessThan(300);
    const afterThird = (await inject('GET', `${docUrl(rec.id)}/versions`)).json();
    expect(afterThird.data).toHaveLength(2);
  });

  it('a version previews as a block-level diff against the CURRENT content — AC #5', async () => {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'R3' } })).json();
    await inject('PUT', docUrl(rec.id), { content: blocknote('original text'), expected_version: 0 });
    await inject('PUT', docUrl(rec.id), { content: blocknote('changed text'), expected_version: 1 });

    const versions = (await inject('GET', `${docUrl(rec.id)}/versions`)).json();
    const versionId = versions.data[0].id;

    const preview = await inject('GET', `${docUrl(rec.id)}/versions/${versionId}`);
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json();
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0].kind).toBe('changed');
    expect(body.blocks[0].blockId).toBe('b1');
  });

  it('restoring is itself reversible — AC #5', async () => {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'R4' } })).json();
    await inject('PUT', docUrl(rec.id), { content: blocknote('alpha'), expected_version: 0 });
    await inject('PUT', docUrl(rec.id), { content: blocknote('beta'), expected_version: 1 });

    const versions = (await inject('GET', `${docUrl(rec.id)}/versions`)).json();
    const alphaVersionId = versions.data[0].id; // the pre-"beta" ("alpha") snapshot

    const restore = await inject('POST', `${docUrl(rec.id)}/versions/${alphaVersionId}/restore`);
    expect(restore.statusCode, restore.body).toBe(201);
    expect(restore.json().content).toEqual(blocknote('alpha'));

    // The pre-restore state ("beta") was itself captured, so THIS restore can be undone too.
    const afterRestore = (await inject('GET', `${docUrl(rec.id)}/versions`)).json();
    expect(afterRestore.data).toHaveLength(2);
    const betaVersionId = afterRestore.data[0].id;
    const undo = await inject('POST', `${docUrl(rec.id)}/versions/${betaVersionId}/restore`);
    expect(undo.statusCode, undo.body).toBe(201);
    expect(undo.json().content).toEqual(blocknote('beta'));
  });

  it('MUST KEEP WORKING: documents.version still functions as the optimistic-concurrency counter — a stale expected_version still 409s', async () => {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'R5' } })).json();
    await inject('PUT', docUrl(rec.id), { content: blocknote('v1'), expected_version: 0 });
    const stale = await inject('PUT', docUrl(rec.id), { content: blocknote('v2'), expected_version: 0 });
    expect(stale.statusCode, stale.body).toBe(409);
  });

  it('404s restoring a version id that does not belong to this record', async () => {
    const recA = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'A' } })).json();
    const recB = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'B' } })).json();
    await inject('PUT', docUrl(recA.id), { content: blocknote('a1'), expected_version: 0 });
    await inject('PUT', docUrl(recA.id), { content: blocknote('a2'), expected_version: 1 });
    const versions = (await inject('GET', `${docUrl(recA.id)}/versions`)).json();
    const versionId = versions.data[0].id;

    const res = await inject('POST', `${docUrl(recB.id)}/versions/${versionId}/restore`);
    expect(res.statusCode).toBe(404);
  });
});
