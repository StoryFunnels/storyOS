import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { blocksToMarkdown, packManifestSchema } from '@storyos/schemas';
import { PACK_REGISTRY } from '../src/packs/registry';
import { createTestApp } from './helpers/app';
import { call, joinAs } from './helpers/members';
import { signUpUser } from './helpers/users';

/**
 * ticket #1218 - record templates: a pack manifest ships them per database, they install with the pack, are editable afterwards,
 * are listed by the API, a record can be saved as one, and a record made from one is pre-filled (fields and body).
 */
const entry = PACK_REGISTRY.find((p) => p.slug === 'dev-tracker')!;

let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Record Templates Owner');
}, 240_000);
afterAll(async () => { await app?.close(); });

interface Opt { id: string; label: string }
interface Fld { id: string; displayName: string; apiName: string; options?: Opt[] }
interface Tpl { id: string; name: string; description: string | null; values: Record<string, unknown>; body: string | null; origin: string }

async function install() {
  const ws = (await as('POST', '/workspaces', { name: `Templates ${Date.now()}-${Math.random()}` })).json().id as string;
  const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
  expect(res.statusCode, res.body).toBe(201);
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; isSystem?: boolean }>;
  const issues = dbs.find((d) => d.name === 'Issues' && !d.isSystem)!;
  const detail = (await as('GET', `/workspaces/${ws}/databases/${issues.id}`)).json() as { fields: Fld[] };
  return { ws, db: issues.id, detail, result: res.json() as { record_templates: Array<{ name: string; action: string; id: string }> } };
}
const opt = (d: { fields: Fld[] }, field: string, label: string) => d.fields.find((f) => f.displayName === field)!.options!.find((o) => o.label === label)!.id;
const list = async (ws: string, db: string) => ((await as('GET', `/workspaces/${ws}/databases/${db}/record-templates`)).json().data ?? []) as Tpl[];
const bodyOf = async (ws: string, db: string, rec: string) => {
  const doc = (await as('GET', `/workspaces/${ws}/databases/${db}/records/${rec}/document`)).json() as { content: unknown[] | null };
  return doc.content ? blocksToMarkdown(doc.content as never) : '';
};
const uninstall = async (ws: string) => {
  const inst = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
  const res = await as('POST', `/workspaces/${ws}/packs/${inst.find((i) => i.slug === 'dev-tracker')!.id}/uninstall`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string; reason?: string }> };
};

describe('#1218 the manifest', () => {
  it('Dev Tracker declares Bug, Feature and Improvement for Issues, each with preset values and a body of sections', () => {
    expect(packManifestSchema.safeParse(entry.manifest).success).toBe(true);
    const t = entry.manifest.record_templates ?? [];
    expect(t.map((x) => [x.database, x.name])).toEqual([['Issues', 'Bug'], ['Issues', 'Feature'], ['Issues', 'Improvement']]);
    for (const x of t) {
      expect(Object.keys(x.values).sort()).toEqual(['labels', 'name', 'priority', 'state']);
      expect(x.body).toMatch(/^## /);
    }
    expect(t[0]!.body).toContain('## Steps to reproduce');
    expect(t[0]!.body).toContain('## Expected');
    expect(t[0]!.body).toContain('## Actual');
    expect(t[0]!.body).toContain('## Environment');
    expect(t[1]!.body).toContain('## Problem');
    expect(t[1]!.body).toContain('## Proposal');
    expect(t[1]!.body).toContain('## Acceptance criteria');
  });

  it('a manifest with no record_templates key still parses, and parses to no key (a pinned manifest does not grow one)', () => {
    const other = PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest;
    const parsed = packManifestSchema.parse(other);
    expect('record_templates' in parsed).toBe(false);
  });
});

describe('#1218 install lists them; creating from one pre-fills fields and body', () => {
  it('installs the three templates with real option ids, listed by the API', async () => {
    const { ws, db, detail, result } = await install();
    expect(result.record_templates.map((r) => [r.name, r.action])).toEqual([['Issues: Bug', 'created'], ['Issues: Feature', 'created'], ['Issues: Improvement', 'created']]);
    const templates = await list(ws, db);
    expect(templates.map((t) => t.name).sort()).toEqual(['Bug', 'Feature', 'Improvement']);
    const bug = templates.find((t) => t.name === 'Bug')!;
    expect(bug.origin).toBe('pack');
    expect(bug.values['state']).toBe(opt(detail, 'State', 'Triage'));
    expect(bug.values['priority']).toBe(opt(detail, 'Priority', 'Medium'));
    expect(bug.values['labels']).toEqual([opt(detail, 'Labels', 'Bug')]);
  });

  it('creating a record from Bug fills State, Priority, Labels, the title override and the body sections', async () => {
    const { ws, db, detail } = await install();
    const bug = (await list(ws, db)).find((t) => t.name === 'Bug')!;
    const res = await as('POST', `/workspaces/${ws}/databases/${db}/record-templates/${bug.id}/records`, { values: { name: 'Login fails on Safari' } });
    expect(res.statusCode, res.body).toBe(201);
    const { record, skipped } = res.json() as { record: { id: string; title: string; values: Record<string, unknown> }; skipped: unknown[] };
    expect(skipped).toEqual([]);
    expect(record.title).toBe('Login fails on Safari');
    const got = (await as('GET', `/workspaces/${ws}/databases/${db}/records/${record.id}`)).json() as { values: Record<string, unknown> };
    const idOf = (v: unknown) => (Array.isArray(v) ? v.map((x) => (x as { id?: string }).id ?? x) : ((v as { id?: string })?.id ?? v));
    expect(idOf(got.values['state'])).toBe(opt(detail, 'State', 'Triage'));
    expect(idOf(got.values['priority'])).toBe(opt(detail, 'Priority', 'Medium'));
    expect(idOf(got.values['labels'])).toEqual([opt(detail, 'Labels', 'Bug')]);
    const body = await bodyOf(ws, db, record.id);
    for (const s of ['## Steps to reproduce', '## Expected', '## Actual', '## Environment']) expect(body).toContain(s);
  });

  it('a preset naming a field that no longer exists is dropped and reported, and the record is still made', async () => {
    const { ws, db } = await install();
    const bug = (await list(ws, db)).find((t) => t.name === 'Bug')!;
    const edit = await as('PATCH', `/workspaces/${ws}/databases/${db}/record-templates/${bug.id}`, { values: { ...bug.values, ghost_field: 'x' } });
    expect(edit.statusCode, edit.body).toBe(200);
    const res = await as('POST', `/workspaces/${ws}/databases/${db}/record-templates/${bug.id}/records`, { values: {} });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { skipped: Array<{ field: string }> }).skipped.map((s) => s.field)).toEqual(['ghost_field']);
  });
});

describe('#1218 a person can author, edit and save a record as a template', () => {
  it('saves a record as a template (values and body, not its title), and a record made from it matches', async () => {
    const { ws, db, detail } = await install();
    const mk = await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'Original', priority: opt(detail, 'Priority', 'Urgent') } });
    const rec = mk.json().id as string;
    expect((await as('PUT', `/workspaces/${ws}/databases/${db}/records/${rec}/document`, { content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Checklist body' }] }], expected_version: 0 })).statusCode).toBeLessThan(300);

    const saved = await as('POST', `/workspaces/${ws}/databases/${db}/record-templates/from-record`, { record_id: rec, name: 'Urgent thing' });
    expect(saved.statusCode, saved.body).toBe(201);
    const t = saved.json() as Tpl;
    expect(t.origin).toBe('user');
    expect(t.values['priority']).toBe(opt(detail, 'Priority', 'Urgent'));
    expect('name' in t.values).toBe(false);
    expect(t.body).toContain('Checklist body');

    const made = await as('POST', `/workspaces/${ws}/databases/${db}/record-templates/${t.id}/records`, { values: { name: 'Copy' } });
    expect(made.statusCode, made.body).toBe(201);
    expect(await bodyOf(ws, db, (made.json() as { record: { id: string } }).record.id)).toContain('Checklist body');
  });

  it('refuses a second template with the same name (409), and a viewer-level member can list but not create', async () => {
    const { ws, db } = await install();
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/record-templates`, { name: 'bug' })).statusCode).toBe(409);
    const guest = await joinAs(app, owner.token, ws, 'Template Guest', 'guest', [{ database_id: db, role: 'viewer' }]);
    expect((await call(app, guest.token, 'GET', `/workspaces/${ws}/databases/${db}/record-templates`)).statusCode).toBe(200);
    expect((await call(app, guest.token, 'POST', `/workspaces/${ws}/databases/${db}/record-templates`, { name: 'Nope' })).statusCode).toBe(403);
    const bug = (await list(ws, db)).find((t) => t.name === 'Bug')!;
    expect((await call(app, guest.token, 'POST', `/workspaces/${ws}/databases/${db}/record-templates/${bug.id}/records`, {})).statusCode).toBe(403);
  });

  it('deletes a template; records made from it are untouched', async () => {
    const { ws, db } = await install();
    const feat = (await list(ws, db)).find((t) => t.name === 'Feature')!;
    const made = (await as('POST', `/workspaces/${ws}/databases/${db}/record-templates/${feat.id}/records`, { values: { name: 'Keep me' } })).json() as { record: { id: string } };
    expect((await as('DELETE', `/workspaces/${ws}/databases/${db}/record-templates/${feat.id}`)).statusCode).toBe(204);
    expect((await list(ws, db)).map((t) => t.name).sort()).toEqual(['Bug', 'Improvement']);
    expect((await as('GET', `/workspaces/${ws}/databases/${db}/records/${made.record.id}`)).statusCode).toBe(200);
  });
});

describe('#1218 uninstall and re-install treat an edited template as the person\'s', () => {
  it('uninstall removes untouched templates and KEEPS an edited one as "Changed since install"', async () => {
    const { ws, db } = await install();
    const bug = (await list(ws, db)).find((t) => t.name === 'Bug')!;
    expect((await as('PATCH', `/workspaces/${ws}/databases/${db}/record-templates/${bug.id}`, { body: '## My own sections\n' })).statusCode).toBe(200);
    const res = await uninstall(ws);
    expect(res.kept.filter((k) => k.kind === 'record_template')).toEqual([{ kind: 'record_template', name: 'Issues: Bug', id: bug.id, reason: 'Changed since install.' }]);
    expect(res.removed.filter((k) => k.kind === 'record_template').map((k) => k.name).sort()).toEqual(['Issues: Feature', 'Issues: Improvement']);
    expect((await list(ws, db)).map((t) => t.name)).toEqual(['Bug']);
  });

  it('uninstall removes all three when none was touched', async () => {
    const { ws, db } = await install();
    const res = await uninstall(ws);
    expect(res.removed.filter((k) => k.kind === 'record_template')).toHaveLength(3);
    expect(await list(ws, db)).toEqual([]);
  });

  it('re-installing does not overwrite an edit and does not duplicate', async () => {
    const { ws, db } = await install();
    const bug = (await list(ws, db)).find((t) => t.name === 'Bug')!;
    await as('PATCH', `/workspaces/${ws}/databases/${db}/record-templates/${bug.id}`, { body: '## Mine\n' });
    const again = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(again.statusCode, again.body).toBe(201);
    const after = await list(ws, db);
    expect(after).toHaveLength(3);
    expect(after.find((t) => t.name === 'Bug')!.body).toBe('## Mine\n');
  });
});
