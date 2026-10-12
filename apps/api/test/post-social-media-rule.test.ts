import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { attachments, records } from '../src/db/schema';
import { PostSocialActionService } from '../src/automations/post-social.action';

/**
 * #826 — WHICH image does a post_social publish? The approval preview (web) shows and labels "the first
 * attachment of the media field" as what will be posted. The executor used to post the NEWEST upload
 * (`createdAt desc`) while its own doc comment said "first": with two attachments the approver approved
 * one image and a DIFFERENT one was published. There is now ONE rule: the first attachment in the order
 * the FIELD holds them (a person can reorder them), which is what the cell and the preview show.
 *
 * `pickMediaAttachment` is the whole decision; `loadMedia` only streams the chosen file.
 */
let app: NestFastifyApplication;
let db: Db;
let svc: PostSocialActionService;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let fieldId: string;
let otherFieldId: string;

const as = (t: string, m: string, u: string, p?: unknown) => app.inject({ method: m as never, url: `/api/v1${u}`, headers: authed(t), payload: p as never });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  svc = app.get(PostSocialActionService);
  admin = await signUpUser(app, 'Media Rule Admin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'media rule' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Posts' })).json().id;
  const f = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Image', type: 'attachment', config: {} });
  expect(f.statusCode, f.body).toBeLessThan(300);
  fieldId = f.json().id;
  const g = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Other', type: 'attachment', config: {} });
  otherFieldId = g.json().id;
});

afterAll(async () => {
  await app.close();
});

const pick = (recordId: string, field = fieldId) =>
  (svc as unknown as { pickMediaAttachment: (d: string, r: string, f: string) => Promise<{ id: string; filename: string } | null> }).pickMediaAttachment(dbId, recordId, field);

async function recordWith(files: string[], fieldOrder?: number[]) {
  const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: files.join('+') } })).json().id as string;
  const ids: string[] = [];
  for (const [i, filename] of files.entries()) {
    const [row] = await db
      .insert(attachments)
      .values({ recordId: rec, fieldId, filename, size: 1, mime: 'image/png', storageKey: `k-${rec}-${i}`, createdAt: new Date(Date.now() - (files.length - i) * 60_000) })
      .returning();
    ids.push(row!.id);
  }
  // The field's own value: the ordered ids, optionally REORDERED by a person.
  const order = fieldOrder ?? files.map((_, i) => i);
  const current = (await db.query.records.findFirst({ where: eq(records.id, rec) }))!.values as Record<string, unknown>;
  await db.update(records).set({ values: { ...current, [fieldId]: order.map((i) => ids[i]) } }).where(eq(records.id, rec));
  return { rec, ids };
}

describe('#826 — the executor publishes the image the approval preview shows', () => {
  it('two attachments: the FIRST in the field order goes out, not the newest upload', async () => {
    const { rec, ids } = await recordWith(['first-uploaded.png', 'second-uploaded.png']);
    const chosen = await pick(rec);
    expect(chosen!.id, 'the first in the field, which is the OLDER upload').toBe(ids[0]);
    expect(chosen!.filename).toBe('first-uploaded.png');
  });

  it('a person REORDERS the attachments: the new first one goes out (what the cell and the preview show)', async () => {
    const { rec, ids } = await recordWith(['a.png', 'b.png', 'c.png'], [2, 0, 1]);
    expect((await pick(rec))!.id).toBe(ids[2]);
  });

  it('an id on the field that no longer resolves is skipped; an empty field value falls back to the oldest upload; no attachment is null', async () => {
    const { rec, ids } = await recordWith(['old.png', 'new.png']);
    const current = (await db.query.records.findFirst({ where: eq(records.id, rec) }))!.values as Record<string, unknown>;
    await db.update(records).set({ values: { ...current, [fieldId]: ['00000000-0000-4000-8000-000000000000', ids[1]] } }).where(eq(records.id, rec));
    expect((await pick(rec))!.id, 'the stale id is skipped, the next real one is used').toBe(ids[1]);
    await db.update(records).set({ values: { ...current, [fieldId]: [] } }).where(eq(records.id, rec));
    expect((await pick(rec))!.id, 'empty value: the oldest upload, the order the chips show').toBe(ids[0]);
    const bare = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'no image' } })).json().id as string;
    expect(await pick(bare)).toBeNull();
  });

  it('an attachment in a DIFFERENT field of the same record is never picked', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'other field' } })).json().id as string;
    await db.insert(attachments).values({ recordId: rec, fieldId: otherFieldId, filename: 'elsewhere.png', size: 1, mime: 'image/png', storageKey: `k-other-${rec}` });
    expect(await pick(rec)).toBeNull();
  });
});
