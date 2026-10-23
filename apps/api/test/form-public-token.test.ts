import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { resolveFormSharing, stripPublicSharing } from '../src/views/view-sharing';

/**
 * #1041 — a form's public token was chosen by the browser, stored as sent, copied by duplicate and by packs, and found
 * by a `LIMIT 1` scan with no ordering and no unique index. Anyone who had seen one form link could register the same
 * token in their own workspace and the public URL resolved to either; the respondent's answers (PII) could land in the
 * attacker's database. The attack is run as the attacker; the assertion is where the VICTIM's public URL resolves.
 */
let app: NestFastifyApplication;
let victim: { token: string };
let attacker: { token: string };
let vSpaceName: string;
let vWs: string, aWs: string, vDb: string, aDb: string, vName: string, aName: string;
const { db } = connectTestDb();

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
const pub = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never });
const formCfg = (nameField: string, form: Record<string, unknown>) => ({
  sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {},
  form: { title: 'Contact', fields: [{ field_id: nameField, required: true }], ...form },
});
const makeForm = (token: string, ws: string, dbId: string, nameField: string, form: Record<string, unknown>) =>
  as(token, 'POST', `/workspaces/${ws}/databases/${dbId}/views`, { name: 'Form', type: 'form', config: formCfg(nameField, form) });
/** drizzle wraps the driver error ("Failed query"), so the unique violation is on `.cause`. */
async function expectUniqueViolation(q: Promise<unknown>, index: string) {
  const err = await q.then(() => null, (e: { message?: string; cause?: { message?: string; constraint?: string } }) => e);
  expect(err, 'the write must be refused').not.toBeNull();
  expect(`${err!.cause?.message ?? ''} ${err!.cause?.constraint ?? ''} ${err!.message}`).toContain(index);
}
const tokenOf = (res: { json: () => { config: { form?: { public_token?: string } } } }) => res.json().config.form?.public_token;

async function workspaceWithDb(token: string, label: string) {
  const ws = (await as(token, 'POST', '/workspaces', { name: `${label} WS` })).json().id as string;
  const space = (await as(token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const dbId = (await as(token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: `${label} leads` })).json().id as string;
  const fields = (await as(token, 'GET', `/workspaces/${ws}/databases/${dbId}`)).json().fields as Array<{ id: string; type: string; api_name: string }>;
  return { ws, dbId, nameField: fields.find((f) => f.type === 'title' || f.api_name === 'name')!.id };
}

beforeAll(async () => {
  app = await createTestApp();
  victim = await signUpUser(app, 'Form Victim');
  attacker = await signUpUser(app, 'Form Attacker');
  const v = await workspaceWithDb(victim.token, 'Victim');
  const a = await workspaceWithDb(attacker.token, 'Attacker');
  vSpaceName = (await as(victim.token, 'GET', `/workspaces/${v.ws}/spaces`)).json()[0].name;
  vWs = v.ws; vDb = v.dbId; vName = v.nameField; aWs = a.ws; aDb = a.dbId; aName = a.nameField;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1041 the attack: claiming a token someone else already published', () => {
  it('registering a victim token on the attacker\'s own form does NOT hijack the victim\'s public URL', async () => {
    const original = await makeForm(victim.token, vWs, vDb, vName, { access: 'public' });
    expect(original.statusCode, original.body).toBe(201);
    const victimToken = tokenOf(original)!;
    expect(victimToken).toBeTruthy();

    // The attacker saw the link and sends the SAME token as their own form's token, on create…
    const onCreate = await makeForm(attacker.token, aWs, aDb, aName, { access: 'public', public_token: victimToken });
    expect(onCreate.statusCode, onCreate.body).toBe(201);
    expect(tokenOf(onCreate), 'the sent token was not taken').not.toBe(victimToken);
    // …and on update.
    const attackerForm = (await makeForm(attacker.token, aWs, aDb, aName, { access: 'members' })).json();
    const onUpdate = await as(attacker.token, 'PATCH', `/workspaces/${aWs}/databases/${aDb}/views/${attackerForm.id}`, { config: formCfg(aName, { access: 'public', public_token: victimToken }) });
    expect(onUpdate.statusCode, onUpdate.body).toBe(200);
    expect(tokenOf(onUpdate)).not.toBe(victimToken);

    // THE ASSERTION: the victim's URL resolves to the victim's form, deterministically, and a submission lands in the victim's database.
    const def = await pub('GET', `/public/forms/${victimToken}`);
    expect(def.statusCode).toBe(200);
    expect(def.json().title).toBe('Contact');
    const submit = await pub('POST', `/public/forms/${victimToken}`, { values: { name: 'Respondent PII' } });
    expect(submit.statusCode, submit.body).toBeLessThan(300);
    const victimRows = (await as(victim.token, 'GET', `/workspaces/${vWs}/databases/${vDb}/records?limit=50`)).json().data as Array<{ title: string }>;
    const attackerRows = (await as(attacker.token, 'GET', `/workspaces/${aWs}/databases/${aDb}/records?limit=50`)).json().data as Array<{ title: string }>;
    expect(victimRows.map((r) => r.title)).toContain('Respondent PII');
    expect(attackerRows.map((r) => r.title), 'nothing reached the attacker').not.toContain('Respondent PII');
  });

  it('the database itself refuses two views with one token (the unique index), for forms and for published views', async () => {
    const a = (await makeForm(victim.token, vWs, vDb, vName, { access: 'public' })).json();
    const b = (await makeForm(victim.token, vWs, vDb, vName, { access: 'public' })).json();
    const dup = sql`UPDATE views SET config = jsonb_set(config, '{form,public_token}', to_jsonb(${a.config.form.public_token}::text)) WHERE id = ${b.id}`;
    await expectUniqueViolation(db.execute(dup), 'views_form_public_token_uq');
    const share = (v: string) => sql`UPDATE views SET config = jsonb_set(config, '{share}', ${JSON.stringify({ public_token: v })}::jsonb) WHERE id = ${b.id}`;
    await db.execute(share('same-share-token'));
    await expectUniqueViolation(db.execute(sql`UPDATE views SET config = jsonb_set(config, '{share}', '{"public_token":"same-share-token"}'::jsonb) WHERE id = ${a.id}`), 'views_share_public_token_uq');
  });

  it('a client cannot set share.public_token through create either (it is service-owned)', async () => {
    const res = await as(attacker.token, 'POST', `/workspaces/${aWs}/databases/${aDb}/views`, {
      name: 'Table', type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {}, share: { public_token: 'chosen-by-client', include_relation_api_names: [], indexable: false } },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().config.share, 'no share block was stored').toBeUndefined();
    expect((await pub('GET', '/public/views/chosen-by-client')).statusCode).toBe(404);
  });
});

describe('#1041 tokens are server-minted and rotate', () => {
  it('a minted token is long and unguessable; members-only forms carry none', async () => {
    const shared = tokenOf(await makeForm(victim.token, vWs, vDb, vName, { access: 'link' }))!;
    expect(shared.length).toBeGreaterThanOrEqual(32);
    expect(shared).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenOf(await makeForm(victim.token, vWs, vDb, vName, { access: 'members' }))).toBeUndefined();
  });

  it('a short or chosen token sent by the client is not what gets stored', async () => {
    const res = await makeForm(victim.token, vWs, vDb, vName, { access: 'public', public_token: 'abc' });
    expect(res.statusCode, res.body).toBe(201);
    expect(tokenOf(res)).not.toBe('abc');
    expect((await pub('GET', '/public/forms/abc')).statusCode).toBe(404);
  });
});

describe('#1041 a copy never carries a public token', () => {
  it('duplicating a shared form yields a members-only form with no token; the original stays live', async () => {
    const original = (await makeForm(victim.token, vWs, vDb, vName, { access: 'public' })).json();
    const originalToken = original.config.form.public_token as string;
    const dup = await as(victim.token, 'POST', `/workspaces/${vWs}/databases/${vDb}/views/${original.id}/duplicate`);
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    expect(dup.json().config.form.public_token, 'no token on the copy').toBeUndefined();
    expect(dup.json().config.form.access, 'and it fails closed').toBe('members');
    expect((await pub('GET', `/public/forms/${originalToken}`)).statusCode).toBe(200);
    // unpublishing the original leaves no live duplicate on the same URL
    await as(victim.token, 'PATCH', `/workspaces/${vWs}/databases/${vDb}/views/${original.id}`, { config: formCfg(vName, { access: 'members' }) });
    expect((await pub('GET', `/public/forms/${originalToken}`)).statusCode).toBe(404);
  });

  it('duplicating a PUBLISHED view does not copy its share block', async () => {
    const table = (await as(victim.token, 'POST', `/workspaces/${vWs}/databases/${vDb}/views`, { name: 'T', type: 'table', config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} } })).json();
    const shared = await as(victim.token, 'POST', `/workspaces/${vWs}/databases/${vDb}/views/${table.id}/share`, {});
    expect(shared.statusCode, shared.body).toBeLessThan(300);
    const dup = (await as(victim.token, 'POST', `/workspaces/${vWs}/databases/${vDb}/views/${table.id}/duplicate`)).json();
    expect(dup.config.share).toBeUndefined();
  });

  it('pack export strips tokens, and pack install ignores one in an old manifest', async () => {
    const f = (await makeForm(victim.token, vWs, vDb, vName, { access: 'public' })).json();
    const exported = await as(victim.token, 'POST', `/workspaces/${vWs}/packs/export`, { slug: 'tok-pack', name: 'Tok pack', version: '1.0.0', summary: 's', space: vSpaceName });
    expect(exported.statusCode, exported.body).toBe(201);
    const manifest = exported.json() as { views: Array<{ type: string; config: { form?: Record<string, unknown>; share?: unknown } }> };
    const forms = manifest.views.filter((v) => v.type === 'form');
    expect(forms.length).toBeGreaterThan(0);
    for (const v of forms) { expect(v.config.form).not.toHaveProperty('public_token'); expect(v.config.form!.access).toBe('members'); }
    expect(JSON.stringify(manifest)).not.toContain(f.config.form.public_token);

    // An OLD manifest still carrying a live token: installing it must not resurrect that link.
    const old = JSON.parse(JSON.stringify(manifest));
    for (const v of old.views.filter((x: { type: string }) => x.type === 'form')) { v.config.form.public_token = f.config.form.public_token; v.config.form.access = 'public'; }
    const target = (await as(attacker.token, 'POST', '/workspaces', { name: 'Pack target' })).json().id as string;
    const installed = await as(attacker.token, 'POST', `/workspaces/${target}/packs/install`, { manifest: old });
    expect(installed.statusCode, installed.body).toBe(201);
    expect((await pub('GET', `/public/forms/${f.config.form.public_token}`)).statusCode, 'still the ORIGINAL owner\'s form').toBe(200);
    const targetDbs = (await as(attacker.token, 'GET', `/workspaces/${target}/databases`)).json() as Array<{ id: string }>;
    for (const d of targetDbs) {
      const views = (await as(attacker.token, 'GET', `/workspaces/${target}/databases/${d.id}`)).json().views as Array<{ type: string; config: { form?: { public_token?: string; access?: string } } }>;
      for (const v of views.filter((x) => x.type === 'form')) { expect(v.config.form?.public_token).toBeUndefined(); expect(v.config.form?.access).toBe('members'); }
    }
  });
});

describe('#1041 a deleted view\'s link is dead', () => {
  it('soft-deleting a shared form stops its public URL resolving', async () => {
    const f = (await makeForm(victim.token, vWs, vDb, vName, { access: 'public' })).json();
    const t = f.config.form.public_token as string;
    expect((await pub('GET', `/public/forms/${t}`)).statusCode).toBe(200);
    expect((await as(victim.token, 'DELETE', `/workspaces/${vWs}/databases/${vDb}/views/${f.id}`)).statusCode).toBeLessThan(300);
    expect((await pub('GET', `/public/forms/${t}`)).statusCode).toBe(404);
  });
});

describe('#1041 the migration settles existing collisions before the index exists', () => {
  it('the first holder keeps the token, every other view loses it (forms fail closed, published views unpublish), and a second run changes nothing', async () => {
    const migration = readFileSync(new URL('../drizzle/0118_public_token_unique.sql', import.meta.url), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    const [dedupeForms, dedupeShares, ...indexes] = migration.filter((s) => !s.startsWith('--') || s.includes('WITH') || s.includes('CREATE'));
    expect(dedupeForms).toContain('WITH ranked');
    expect(indexes.length).toBe(2);

    await db.execute(sql`DROP INDEX views_form_public_token_uq`);
    await db.execute(sql`DROP INDEX views_share_public_token_uq`);
    try {
      const mk = async (label: string, cfg: Record<string, unknown>, deleted = false) => {
        const r = (await as(victim.token, 'POST', `/workspaces/${vWs}/databases/${vDb}/views`, { name: label, type: 'table', config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} } })).json();
        await db.execute(sql`UPDATE views SET config = ${JSON.stringify(cfg)}::jsonb, deleted_at = ${deleted ? new Date().toISOString() : null}, created_at = now() + (${label.length}::int * interval '1 second') WHERE id = ${r.id}`);
        return r.id as string;
      };
      const form = (t: string) => ({ form: { title: 'x', fields: [], access: 'public', public_token: t } });
      const keep = await mk('A', form('collide-form'));
      const loser = await mk('BB', form('collide-form'));
      const deletedFirst = await mk('C', form('collide-form-2'), true); // a deleted view must not outrank a live one
      const liveSecond = await mk('DDDD', form('collide-form-2'));
      const shareKeep = await mk('E', { share: { public_token: 'collide-share' } });
      const shareLoser = await mk('FF', { share: { public_token: 'collide-share' } });
      const cfg = async (id: string) => ((await db.execute(sql`SELECT config FROM views WHERE id = ${id}`)) as unknown as { rows: Array<{ config: any }> }).rows[0]!.config;

      await db.execute(sql.raw(dedupeForms!));
      await db.execute(sql.raw(dedupeShares!));
      expect((await cfg(keep)).form.public_token).toBe('collide-form');
      const l = await cfg(loser);
      expect(l.form.public_token, 'the loser lost the token').toBeUndefined();
      expect(l.form.access, 'and fails closed').toBe('members');
      expect((await cfg(liveSecond)).form.public_token, 'the LIVE view outranks the deleted one').toBe('collide-form-2');
      expect((await cfg(deletedFirst)).form.public_token).toBeUndefined();
      expect((await cfg(shareKeep)).share.public_token).toBe('collide-share');
      expect((await cfg(shareLoser)).share.public_token).toBeUndefined();

      const before = JSON.stringify([await cfg(keep), await cfg(loser), await cfg(liveSecond)]);
      await db.execute(sql.raw(dedupeForms!));
      await db.execute(sql.raw(dedupeShares!));
      expect(JSON.stringify([await cfg(keep), await cfg(loser), await cfg(liveSecond)]), 'idempotent').toBe(before);
    } finally {
      for (const stmt of indexes) await db.execute(sql.raw(stmt));
    }
  });
});

describe('#1041 resolveFormSharing / stripPublicSharing (pure)', () => {
  const form = (o: Record<string, unknown>) => ({ fields: [], access: 'members', ...o }) as never;
  it('ignores a sent token; keeps the existing one; mints only when access leaves members; drops it on members', () => {
    expect((resolveFormSharing(form({ access: 'link', public_token: 'sent' }), undefined) as { public_token: string }).public_token).not.toBe('sent');
    expect((resolveFormSharing(form({ access: 'link', public_token: 'sent' }), form({ access: 'link', public_token: 'live' })) as { public_token: string }).public_token).toBe('live');
    expect(resolveFormSharing(form({ access: 'members', public_token: 'sent' }), undefined)).not.toHaveProperty('public_token');
    expect(resolveFormSharing(form({ access: 'members' }), form({ access: 'link', public_token: 'live' }))).not.toHaveProperty('public_token');
    expect(resolveFormSharing(undefined, form({ access: 'link', public_token: 'live' }))).toMatchObject({ public_token: 'live' });
  });
  it('stripPublicSharing removes the token and the share block and forces members-only', () => {
    expect(stripPublicSharing({ a: 1, share: { public_token: 's' }, form: { fields: [], access: 'public', public_token: 't' } })).toEqual({ a: 1, form: { fields: [], access: 'members' } });
    expect(stripPublicSharing({ a: 1 })).toEqual({ a: 1 });
    expect(stripPublicSharing(null)).toBeNull();
  });
});
