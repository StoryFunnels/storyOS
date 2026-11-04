import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema, type PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { PACK_REGISTRY } from '../src/packs/registry';
import { topNOf } from '../src/packs/packs.service';

/**
 * Ticket #1199 — a pack manifest carries `sort` / `limit` on a SCHEDULED automation ("the 5 deals stalled longest" digest).
 *
 * The rule itself has carried top-N since ticket #392; what was missing is the manifest: its automation schema had no such keys, so
 * export dropped them, install created a rule without them, and the install hash ignored them (a person editing the limit would
 * never have counted as "Changed since install").
 */

let app: NestFastifyApplication;
let admin: { token: string };
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Pack Top N');
}, 90_000);
afterAll(async () => { await app?.close(); });

const SORT = [{ field: 'updated_at', direction: 'asc' as const }];
const DIGEST = 'Stalled digest';

/** Support Inbox plus one scheduled top-N rule and one plain scheduled rule. */
function manifestWith(slug: string, extra: Array<Record<string, unknown>>): PackManifest {
  const base = PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest;
  const m = structuredClone(base) as PackManifest;
  m.slug = slug;
  m.automations = [...m.automations, ...extra] as never;
  return m;
}
const digest = (over: Record<string, unknown> = {}) => ({
  database: 'Tickets',
  name: DIGEST,
  trigger: { type: 'schedule', every: 'day', at: '09:00' },
  actions: [{ type: 'add_comment', body_template: 'Stalled' }],
  enabled: true,
  sort: SORT,
  limit: 5,
  ...over,
});

const newWs = async () => (await as('POST', '/workspaces', { name: `Pack top-N ${Date.now()}` })).json().id as string;
async function install(ws: string, m: unknown, resolutions?: unknown) {
  const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, resolutions });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
async function ticketsDb(ws: string) {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  return dbs.find((d) => d.name === 'Tickets')!.id;
}
type Rule = { id: string; name: string; sort: unknown; topNLimit: number | null };
async function rules(ws: string, db: string) {
  return ((await as('GET', `/workspaces/${ws}/databases/${db}/automations`)).json().data as Rule[]);
}
async function uninstall(ws: string, slug: string) {
  const list = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
  const res = await as('POST', `/workspaces/${ws}/packs/${list.find((i) => i.slug === slug)!.id}/uninstall`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string; reason?: string }> };
}
const automationNames = (xs: Array<{ kind: string; name: string }>) => xs.filter((x) => x.kind === 'automation').map((x) => x.name);

describe('#1199 manifest schema', () => {
  const parse = (a: Record<string, unknown>) => {
    const m = manifestWith('schema-probe', [a]);
    return packManifestSchema.safeParse(m);
  };

  it('accepts sort + limit on a schedule trigger and keeps them (not stripped)', () => {
    const r = parse(digest());
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    const rule = r.data!.automations.find((a) => a.name === DIGEST)!;
    expect(rule.sort).toEqual(SORT);
    expect(rule.limit).toBe(5);
  });

  it('rejects sort/limit on a non-schedule trigger, exactly as the rule API does', () => {
    expect(parse(digest({ trigger: { type: 'record_created' } })).success).toBe(false);
    expect(parse(digest({ trigger: { type: 'record_created' }, sort: undefined })).success).toBe(false); // limit alone
    expect(parse(digest({ trigger: { type: 'record_created' }, limit: undefined })).success).toBe(false); // sort alone
  });

  it('rejects a limit over the shipped ceiling (200) and below 1; accepts 200', () => {
    expect(parse(digest({ limit: 201 })).success).toBe(false);
    expect(parse(digest({ limit: 0 })).success).toBe(false);
    expect(parse(digest({ limit: 200 })).success).toBe(true);
  });

  it('rejects more than three sort keys', () => {
    const four = ['a', 'b', 'c', 'd'].map((field) => ({ field, direction: 'asc' }));
    expect(parse(digest({ sort: four })).success).toBe(false);
  });

  it('MUST KEEP: a rule with neither key still parses and carries neither key', () => {
    const r = parse({ ...digest(), sort: undefined, limit: undefined });
    expect(r.success).toBe(true);
    const rule = r.data!.automations.find((a) => a.name === DIGEST)!;
    expect('sort' in rule && rule.sort !== undefined).toBe(false);
    expect('limit' in rule && rule.limit !== undefined).toBe(false);
  });
});

describe('#1199 install and uninstall', () => {
  it('install creates the rule WITH its sort and limit', async () => {
    const ws = await newWs();
    await install(ws, manifestWith('topn-install', [digest()]));
    const live = (await rules(ws, await ticketsDb(ws))).find((r) => r.name === DIGEST)!;
    expect(live.sort).toEqual(SORT);
    expect(live.topNLimit).toBe(5);
  }, 90_000);

  it('uninstall removes an untouched top-N rule AND the plain rules the pack always had', async () => {
    const ws = await newWs();
    await install(ws, manifestWith('topn-clean', [digest()]));
    const out = await uninstall(ws, 'topn-clean');
    expect(automationNames(out.kept)).toEqual([]);
    expect(automationNames(out.removed)).toContain(`Tickets.${DIGEST}`);
    expect(automationNames(out.removed)).toContain('Tickets.Notify on status change'); // MUST KEEP: existing hash unchanged for a rule without sort/limit
    expect(await rules(ws, await ticketsDb(ws))).toEqual([]);
  }, 90_000);

  it('a limit edit counts as a user modification: uninstall KEEPS the rule and says "Changed since install."', async () => {
    const ws = await newWs();
    await install(ws, manifestWith('topn-limit-edit', [digest()]));
    const db = await ticketsDb(ws);
    const live = (await rules(ws, db)).find((r) => r.name === DIGEST)!;
    const patch = await as('PATCH', `/workspaces/${ws}/databases/${db}/automations/${live.id}`, { limit: 7 });
    expect(patch.statusCode, patch.body).toBe(200);

    const out = await uninstall(ws, 'topn-limit-edit');
    expect(out.kept.find((k) => k.name === `Tickets.${DIGEST}`)?.reason).toBe('Changed since install.');
    expect((await rules(ws, db)).map((r) => r.name)).toEqual([DIGEST]);
  }, 90_000);

  it('a sort edit counts as a user modification too', async () => {
    const ws = await newWs();
    await install(ws, manifestWith('topn-sort-edit', [digest()]));
    const db = await ticketsDb(ws);
    const live = (await rules(ws, db)).find((r) => r.name === DIGEST)!;
    const patch = await as('PATCH', `/workspaces/${ws}/databases/${db}/automations/${live.id}`, { sort: [{ field: 'created_at', direction: 'desc' }] });
    expect(patch.statusCode, patch.body).toBe(200);
    const out = await uninstall(ws, 'topn-sort-edit');
    expect(out.kept.find((k) => k.name === `Tickets.${DIGEST}`)?.reason).toBe('Changed since install.');
  }, 90_000);

  it('a rule REUSED by name on a second install hashes from the live rule, sort/limit included, so it is not called edited', async () => {
    const ws = await newWs();
    await install(ws, manifestWith('topn-reuse-a', [digest()]));
    const REUSE = Object.fromEntries(['Tickets', 'Triage', 'Tickets.Board', `Tickets.${DIGEST}`, 'Tickets.Notify on status change'].map((k) => [k, { action: 'reuse' }]));
    const res = await install(ws, manifestWith('topn-reuse-b', [digest()]), REUSE);
    expect((res.automations as Array<{ name: string; action: string }>).find((a) => a.name === `Tickets.${DIGEST}`)?.action).toBe('reused');
    const out = await uninstall(ws, 'topn-reuse-b');
    expect(automationNames(out.kept)).toEqual([]);
  }, 90_000);

  it('a sort on a field the database does not have fails the install loudly and leaves no rule behind', async () => {
    const ws = await newWs();
    const res = await as('POST', `/workspaces/${ws}/packs/install`, {
      manifest: manifestWith('topn-bad-field', [digest({ sort: [{ field: 'no_such_field', direction: 'desc' }] })]),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toContain('no_such_field');
  }, 90_000);

  it('the install endpoint rejects a non-schedule rule that carries sort/limit with a 4xx, never a 500', async () => {
    const ws = await newWs();
    const res = await as('POST', `/workspaces/${ws}/packs/install`, {
      manifest: manifestWith('topn-bad-trigger', [digest({ trigger: { type: 'record_created' } })]),
    });
    expect(res.statusCode).toBe(422);
  }, 90_000);
});

describe('#1199 export round trip', () => {
  it('exports sort and limit on a scheduled rule, and omits both keys on a rule without them', async () => {
    const ws = await newWs();
    await install(ws, manifestWith('topn-export-src', [digest()]));
    const res = await as('POST', `/workspaces/${ws}/packs/export`, { slug: 'topn-export-out', name: 'Top N out', why: 'Probe', can: ['Probe'], database_ids: [await ticketsDb(ws)] });
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json().manifest ?? res.json();
    const rule = (out.automations as Array<Record<string, unknown>>).find((a) => a.name === DIGEST)!;
    expect(rule.sort).toEqual(SORT);
    expect(rule.limit).toBe(5);
    const plain = (out.automations as Array<Record<string, unknown>>).find((a) => a.name === 'Notify on status change')!;
    expect('sort' in plain).toBe(false);
    expect('limit' in plain).toBe(false);
    // and what we exported installs again
    expect(packManifestSchema.safeParse(out).success).toBe(true);
  }, 90_000);
});

describe('#1199 the install-hash projection stays byte-compatible with packs installed before it', () => {
  it('a rule with no top-N contributes NO keys (not sort: null), so an old install row still matches its live rule', () => {
    expect(topNOf({ sort: null, topNLimit: null })).toEqual({});
    expect(topNOf({ sort: [], topNLimit: null })).toEqual({});
    expect(topNOf({})).toEqual({});
  });
  it('a rule with top-N contributes exactly sort and limit', () => {
    expect(topNOf({ sort: SORT, topNLimit: 5 })).toEqual({ sort: SORT, limit: 5 });
  });
});
