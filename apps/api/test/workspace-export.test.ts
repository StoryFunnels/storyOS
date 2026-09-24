import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #320: the owner-facing full-workspace `.zip` export. A whole workspace goes out —
 * schema, records, the relation graph and attachment bytes — and only an admin can
 * take it. The archive is unzipped in-test and its entries asserted.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let projectsDb: string;
let clientsDb: string;
let siteRedesign: string;
let acme: string;
let projectFieldId: string;
let attachmentId: string;

const BOUNDARY = 'X-STORYOS-EXPORT-BOUNDARY';
const ATTACHMENT_BYTES = Buffer.from('hello export attachment');

function multipartBody(filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Owner');
  member = await signUpUser(app, 'PlainMember');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Export WS' })).json().id;

  // A non-admin member, to prove the export is admin-only.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token: inviteToken });

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  projectsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  clientsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;

  // A select field so we can assert schema (options) round-trips.
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
    display_name: 'Stage',
    type: 'select',
    options: [{ label: 'Active' }, { label: 'Done' }],
  });

  siteRedesign = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Site redesign' } })).json().id;
  acme = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Acme' } })).json().id;

  // A relation + a link between the two records.
  const relation = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsDb,
    database_b_id: clientsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Client',
    field_b_name: 'Projects',
  });
  projectFieldId = relation.json().field_a.id;
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/links/${projectFieldId}`, { record_ids: [acme] });

  // An attachment on the project record.
  const up = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${projectsDb}/records/${siteRedesign}/attachments`,
    headers: { ...authed(admin.token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody('brief.txt', 'text/plain', ATTACHMENT_BYTES),
  });
  attachmentId = up.json().id;
});

afterAll(async () => {
  await app.close();
});

async function exportZip(token: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/export/workspace.zip`,
    headers: authed(token),
  });
  return res;
}

describe('workspace export access (#320)', () => {
  it('lets an admin download the workspace as a .zip attachment', async () => {
    const res = await exportZip(admin.token);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="workspace-.*\.zip"/);
  });

  it('refuses a non-admin member with 403', async () => {
    const res = await exportZip(member.token);
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/00000000-0000-4000-8000-000000000000/export/workspace.zip`,
      headers: authed(admin.token),
    });
    // Non-member of a (non-existent) workspace: 404, never a leak.
    expect(res.statusCode).toBe(404);
  });
});

describe('workspace export contents (#320)', () => {
  let zip: AdmZip;
  let entries: string[];

  beforeAll(async () => {
    const res = await exportZip(admin.token);
    zip = new AdmZip(res.rawPayload);
    entries = zip.getEntries().map((e) => e.entryName);
  });

  it('contains a manifest indexing the databases', () => {
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.format).toBe('storyos-workspace-export');
    // #293 — bumped to 2 when documents.json (standalone space documents +
    // shared views) was added; a future importer keys off this to know
    // whether that file exists.
    expect(manifest.format_version).toBe(2);
    expect(manifest.workspace.id).toBe(wsId);
    expect(manifest.counts.databases).toBe(2);
    expect(manifest.counts.relations).toBe(1);
    expect(manifest.counts.attachments).toBe(1);
    const paths = manifest.spaces.flatMap((s: { databases: { path: string }[] }) => s.databases.map((d) => d.path));
    // Every indexed database path is a real archive entry.
    for (const p of paths) expect(entries).toContain(p);
  });

  it('exports each database with its field schema and records (values by field id)', () => {
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const projectsPath = manifest.spaces
      .flatMap((s: { databases: { id: string; path: string }[] }) => s.databases)
      .find((d: { id: string }) => d.id === projectsDb).path;

    const db = JSON.parse(zip.readAsText(projectsPath));
    expect(db.database.id).toBe(projectsDb);

    // The select field's options are captured, so its stored option ids resolve.
    const stage = db.fields.find((f: { type: string; api_name: string }) => f.api_name === 'stage');
    expect(stage.type).toBe('select');
    expect(stage.options.map((o: { label: string }) => o.label).sort()).toEqual(['Active', 'Done']);

    const rec = db.records.find((r: { id: string }) => r.id === siteRedesign);
    expect(rec, 'the record is present').toBeTruthy();
    expect(rec.title).toBe('Site redesign');
    // Attachment reference points at the bytes in the archive.
    expect(rec.attachments).toHaveLength(1);
    expect(rec.attachments[0].id).toBe(attachmentId);
    expect(entries).toContain(rec.attachments[0].path);
  });

  it('reconstructs the relation graph from stable record ids', () => {
    const rel = JSON.parse(zip.readAsText('relations.json'));
    expect(rel.relations).toHaveLength(1);
    expect(rel.relations[0].database_a_id).toBe(projectsDb);
    expect(rel.relations[0].database_b_id).toBe(clientsDb);

    // The single link resolves both endpoints to real exported record ids.
    expect(rel.links).toHaveLength(1);
    const link = rel.links[0];
    expect([link.from_record_id, link.to_record_id].sort()).toEqual([siteRedesign, acme].sort());
    expect(link.relation_id).toBe(rel.relations[0].id);
  });

  it('includes the attachment bytes, pulled through the storage seam', () => {
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const projectsPath = manifest.spaces
      .flatMap((s: { databases: { id: string; path: string }[] }) => s.databases)
      .find((d: { id: string }) => d.id === projectsDb).path;
    const db = JSON.parse(zip.readAsText(projectsPath));
    const path = db.records.find((r: { id: string }) => r.id === siteRedesign).attachments[0].path;

    const bytes = zip.readFile(path);
    expect(bytes, 'the attachment file is in the archive').toBeTruthy();
    expect(bytes!.equals(ATTACHMENT_BYTES)).toBe(true);
  });
});

/**
 * #293 — the export boundary for standalone space documents and shared
 * views. Vera's live reproduction (2026-09-24): a real export on a workspace
 * with a moved (now-shared) document produced a zip with no `documents`
 * entry at all and no `counts.documents` key — `workspace-export.service.ts`
 * had zero references to `documents`/`spaceDocuments`. Fixed by adding
 * `documents.json`, scoped by the SAME personal-space exclusion the rest of
 * the export already applies (spaceRows already excludes personal spaces —
 * nothing personal-space-specific needed re-deriving for documents).
 *
 * Per personal-space.md / #291: a VIEW's privacy is `ownerUserId`, not
 * `spaceId` — a personal view is a private window onto shared data, not a
 * private container — so its exclusion is checked independently of which
 * space it's under, exactly like the rest of this export already treats
 * personal content as private from admins too.
 */
describe('#293 — the export boundary follows a document/view\'s CURRENT container', () => {
  let ws2: string;
  let personalSpaceId: string;
  let sharedSpaceId: string;
  let sharedDb2: string;

  beforeAll(async () => {
    ws2 = (await as(admin.token, 'POST', '/workspaces', { name: '293 Export WS' })).json().id;
    sharedSpaceId = (await as(admin.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
    sharedDb2 = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/databases`, { space_id: sharedSpaceId, name: 'Notes DB' })
    ).json().id;
    personalSpaceId = (await as(admin.token, 'POST', `/workspaces/${ws2}/spaces/personal`)).json().id;
  });

  async function exportZip293() {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ws2}/export/workspace.zip`,
      headers: authed(admin.token),
    });
    return new AdmZip(res.rawPayload);
  }

  it('AC1/AC3 — a document moved OUT of Personal is present, with a non-zero manifest count', async () => {
    const draft = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/spaces/${personalSpaceId}/documents`, { title: 'Still private' })
    ).json();
    // Baseline: still in Personal, must not appear at all.
    const zipStillPersonal = await exportZip293();
    const docsStillPersonal = JSON.parse(zipStillPersonal.readAsText('documents.json'));
    expect(docsStillPersonal.documents.find((d: { id: string }) => d.id === draft.id)).toBeUndefined();
    expect(JSON.parse(zipStillPersonal.readAsText('manifest.json')).counts.documents).toBe(0);

    await as(admin.token, 'POST', `/workspaces/${ws2}/documents/${draft.id}/move`, { space_id: sharedSpaceId });

    const zip = await exportZip293();
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.counts.documents).toBe(1);
    expect(zip.getEntries().map((e) => e.entryName)).toContain('documents.json');
    const docs = JSON.parse(zip.readAsText('documents.json'));
    const exported = docs.documents.find((d: { id: string }) => d.id === draft.id);
    expect(exported, 'the moved document is now present').toBeTruthy();
    expect(exported.title).toBe('Still private');
    expect(exported.space_id).toBe(sharedSpaceId);
  });

  it('AC2 — MUST KEEP WORKING both directions: a shared item forked into Personal via Copy to My Space drops OUT of the export, while the original stays', async () => {
    const shared = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/spaces/${sharedSpaceId}/documents`, { title: 'Shared page' })
    ).json();

    const forked = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/documents/${shared.id}/copy-to-personal`)
    ).json();
    expect(forked.id).not.toBe(shared.id);

    const zip = await exportZip293();
    const docs = JSON.parse(zip.readAsText('documents.json'));
    expect(docs.documents.find((d: { id: string }) => d.id === shared.id), 'the original stays exportable').toBeTruthy();
    expect(docs.documents.find((d: { id: string }) => d.id === forked.id), 'the personal fork is excluded').toBeUndefined();
  });

  it('a shared (published) view is present; a personal view is excluded regardless of its database\'s space', async () => {
    const sharedView = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/databases/${sharedDb2}/views`, { name: 'Shared View', type: 'table' })
    ).json();
    const personalView = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/databases/${sharedDb2}/views/personal`, { name: 'My View', type: 'table' })
    ).json();

    const zip = await exportZip293();
    const docs = JSON.parse(zip.readAsText('documents.json'));
    expect(docs.views.find((v: { id: string }) => v.id === sharedView.id), 'shared view is exported').toBeTruthy();
    expect(docs.views.find((v: { id: string }) => v.id === personalView.id), 'personal view is excluded').toBeUndefined();

    // Publishing the personal view (clearing ownerUserId) must move it into
    // the export too — same "current container" rule as a document's move.
    await as(admin.token, 'POST', `/workspaces/${ws2}/databases/${sharedDb2}/views/${personalView.id}/publish`);
    const zipAfter = await exportZip293();
    const docsAfter = JSON.parse(zipAfter.readAsText('documents.json'));
    expect(docsAfter.views.find((v: { id: string }) => v.id === personalView.id), 'published view now present').toBeTruthy();
  });
});
