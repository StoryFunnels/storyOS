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
    expect(manifest.format_version).toBe(1);
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
