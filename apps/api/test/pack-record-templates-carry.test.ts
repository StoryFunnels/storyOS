import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema } from '@storyos/schemas';
import { PACK_REGISTRY } from '../src/packs/registry';
import { createTestApp } from './helpers/app';
import { call } from './helpers/members';
import { signUpUser } from './helpers/users';

/**
 * ticket #1241 - record templates (#1218) travel with `export_pack` and `duplicate_database`: the manifest carries them per database
 * with option ids as symbolic refs, re-installing restores them, and a duplicate gets its own copies pointing at ITS option ids.
 */
const entry = PACK_REGISTRY.find((p) => p.slug === 'dev-tracker')!;

let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Templates Carry Owner');
}, 240_000);
afterAll(async () => { await app?.close(); });

interface Opt { id: string; label: string }
interface Fld { id: string; displayName: string; options?: Opt[] }
interface Tpl { id: string; name: string; description: string | null; values: Record<string, unknown>; body: string | null; origin: string }
type Db = { id: string; name: string; isSystem?: boolean };

const workspace = async () => (await as('POST', '/workspaces', { name: `Carry ${Date.now()}-${Math.random()}` })).json().id as string;
const issuesOf = async (ws: string) => ((await as('GET', `/workspaces/${ws}/databases`)).json() as Db[]).find((d) => d.name === 'Issues' && !d.isSystem)!;
async function install() {
  const ws = await workspace();
  expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest })).statusCode).toBe(201);
  return { ws, db: await issuesOf(ws) };
}
const detailOf = async (ws: string, db: string) => (await as('GET', `/workspaces/${ws}/databases/${db}`)).json() as { fields: Fld[] };
const opt = (d: { fields: Fld[] }, field: string, label: string) => d.fields.find((f) => f.displayName === field)!.options!.find((o) => o.label === label)!.id;
const list = async (ws: string, db: string) => ((await as('GET', `/workspaces/${ws}/databases/${db}/record-templates`)).json().data ?? []) as Tpl[];

describe('#1241 export_pack carries record templates', () => {
  it('emits record_templates per database with symbolic refs, validates, and re-installs into a fresh workspace', async () => {
    const { ws, db } = await install();
    const detail = await detailOf(ws, db.id);
    const res = await as('POST', `/workspaces/${ws}/packs/export`, { slug: 'exp-tpl', name: 'Exp', version: '1.0.0', database_ids: [db.id] });
    expect(res.statusCode, res.body).toBe(201);
    const manifest = res.json();
    expect(packManifestSchema.safeParse(manifest).success).toBe(true);
    const out = (manifest.record_templates ?? []) as Array<{ database: string; name: string; values: Record<string, unknown>; body?: string }>;
    expect(out.map((t) => [t.database, t.name]).sort()).toEqual([['Issues', 'Bug'], ['Issues', 'Feature'], ['Issues', 'Improvement']]);
    expect(JSON.stringify(out)).not.toContain(opt(detail, 'State', 'Triage'));
    expect(out.find((t) => t.name === 'Bug')!.body).toContain('## Steps to reproduce');

    const ws2 = await workspace();
    const again = await as('POST', `/workspaces/${ws2}/packs/install`, { manifest });
    expect(again.statusCode, again.body).toBe(201);
    const db2 = await issuesOf(ws2);
    const detail2 = await detailOf(ws2, db2.id);
    const restored = await list(ws2, db2.id);
    expect(restored.map((t) => t.name).sort()).toEqual(['Bug', 'Feature', 'Improvement']);
    expect(restored.find((t) => t.name === 'Bug')!.values['state']).toBe(opt(detail2, 'State', 'Triage'));
  });

  it('a database with no templates exports no record_templates key', async () => {
    const ws = await workspace();
    const spaceId = ((await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    const mk = await as('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Plain' });
    const res = await as('POST', `/workspaces/${ws}/packs/export`, { slug: 'exp-none', name: 'Exp', version: '1.0.0', database_ids: [mk.json().id] });
    expect(res.statusCode, res.body).toBe(201);
    expect('record_templates' in res.json()).toBe(false);
  });
});

describe('#1241 duplicate_database copies record templates', () => {
  async function source() {
    const ws = await workspace();
    const spaceId = ((await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Leads' })).json().id as string;
    const stage = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, {
      display_name: 'Stage', type: 'select', options: [{ label: 'Cold', color: 'blue' }, { label: 'Hot', color: 'red' }],
    })).json() as { apiName: string };
    const detail = await detailOf(ws, db);
    const make = await as('POST', `/workspaces/${ws}/databases/${db}/record-templates`, {
      name: 'Hot lead', description: 'edited on source', values: { [stage.apiName]: opt(detail, 'Stage', 'Hot') }, body: '## Next step\n',
    });
    expect(make.statusCode, make.body).toBe(201);
    return { ws, db, stage: stage.apiName, detail };
  }

  it('the copy has the template, its option id remapped to the copy, source untouched, origin user', async () => {
    const { ws, db, stage, detail } = await source();
    const dup = await as('POST', `/workspaces/${ws}/databases/${db}/duplicate`, { name: 'Leads copy' });
    expect(dup.statusCode, dup.body).toBe(201);
    const copyId = dup.json().id as string;
    const copyDetail = await detailOf(ws, copyId);
    const copied = await list(ws, copyId);
    expect(copied.map((t) => t.name)).toEqual(['Hot lead']);
    const t = copied[0]!;
    expect(t.description).toBe('edited on source');
    expect(t.values[stage]).toBe(opt(copyDetail, 'Stage', 'Hot'));
    expect(t.values[stage]).not.toBe(opt(detail, 'Stage', 'Hot'));
    expect(t.body).toContain('## Next step');
    expect(t.origin).toBe('user');
    const src = await list(ws, db);
    expect(src).toHaveLength(1);
    expect(src[0]!.values[stage]).toBe(opt(detail, 'Stage', 'Hot'));
  });

  it('the copy leaves no pack install row behind', async () => {
    const { ws, db } = await source();
    await as('POST', `/workspaces/${ws}/databases/${db}/duplicate`, {});
    const inst = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as unknown[];
    expect(inst).toEqual([]);
  });
});
