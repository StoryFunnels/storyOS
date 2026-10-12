import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { PACK_REGISTRY } from '../src/packs/registry';
import { SOCIAL_COMMAND_CENTER_PACK } from '../src/packs/social-command-center';
import { STARTER_PACKS } from '../src/packs/starter-packs';

/**
 * #456 — the Social Command Center pack ships DISABLED, and says nothing untrue about publishing.
 *
 * Two properties are guarded here the way a reviewer would not: (1) `packAutomationSchema.enabled` DEFAULTS
 * to true, so a rule written without the field ships ON; the test parses the manifest THROUGH the schema,
 * so an omitted `enabled` becomes `true` and fails, for every rule the manifest has now or gains later;
 * (2) the copy is scanned as a WHOLE (summary, names, labels, options, sample records, messages, source notes),
 * not just the blurb, because Otto's ruling covers all of it.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

/** Every string the pack can show a person. */
function allCopy(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(SOCIAL_COMMAND_CENTER_PACK);
  return out;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Social Pack Admin');
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('#456 every rule is explicitly disabled, now and for any rule added later', () => {
  it('parsed through the manifest schema (whose default is ENABLED), every automation is enabled:false', () => {
    const parsed = packManifestSchema.parse(SOCIAL_COMMAND_CENTER_PACK.manifest);
    expect(parsed.automations.length).toBeGreaterThanOrEqual(1);
    for (const rule of parsed.automations) expect(rule.enabled, rule.name).toBe(false);
  });

  it('the guard is real: a rule added WITHOUT the field would ship enabled, and this check sees it', () => {
    const manifest = JSON.parse(JSON.stringify(SOCIAL_COMMAND_CENTER_PACK.manifest));
    manifest.automations.push({ database: 'Posts', name: 'a fifth rule nobody marked', trigger: { type: 'record_created' }, actions: [] });
    const parsed = packManifestSchema.parse(manifest);
    expect(parsed.automations.at(-1)!.enabled, 'the schema default is the hazard').toBe(true);
    expect(parsed.automations.filter((r) => r.enabled !== false).map((r) => r.name)).toEqual(['a fifth rule nobody marked']);
  });

  it('no rule in the pack publishes (a post_social action needs a connection a manifest cannot name)', () => {
    for (const rule of SOCIAL_COMMAND_CENTER_PACK.manifest.automations) {
      for (const action of rule.actions) expect((action as { type: string }).type, rule.name).not.toBe('post_social');
    }
  });
});

describe('#456 the copy claims nothing about publishing working', () => {
  it('says the one true sentence in the summary and the manifest summary', () => {
    const sentence = 'Publishing requires connecting a LinkedIn or X account';
    expect(SOCIAL_COMMAND_CENTER_PACK.summary).toContain(sentence);
    expect(SOCIAL_COMMAND_CENTER_PACK.manifest.summary).toContain(sentence);
  });

  it('no string anywhere in the pack makes a publishing claim, or uses our own word for our problem', () => {
    const claims = [
      /\bauto-?publish/i,
      /\bautomatically\b.*\b(publish|post)/i,
      /\b(publishes|will publish|goes? out|posts? (to|for) )/i,
      /\bone[- ]click\b.*\b(publish|post)/i,
      /\bunverified\b/i,
    ];
    for (const s of allCopy()) for (const re of claims) expect(s, `"${s}" matches ${re}`).not.toMatch(re);
  });
});

describe('#456 installing it changes nothing about the other packs, and fires nothing', () => {
  it('the seven starter packs are exactly as before, and this pack is in the gallery registry', () => {
    expect(STARTER_PACKS.map((p) => p.slug).sort()).toEqual(
      ['agency-os', 'book-launch', 'client-portal', 'coaching-os', 'consulting-os', 'content-engine', 'dev-project-os'],
    );
    expect(PACK_REGISTRY.some((p) => p.slug === 'social-command-center')).toBe(true);
    expect(PACK_REGISTRY.filter((p) => p.slug === 'social-command-center')).toHaveLength(1);
  });

  it('on a workspace with NO connections it installs, creates every rule disabled, suggests sources without creating any, and nothing fires', async () => {
    const ws = (await as('POST', '/workspaces', { name: `Social ${Date.now()}` })).json().id as string;
    const install = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: SOCIAL_COMMAND_CENTER_PACK.manifest });
    expect(install.statusCode, install.body).toBe(201);
    const body = install.json();
    expect(body.databases.map((d: { name: string }) => d.name).sort()).toEqual(['Channels', 'Engagement', 'Metrics', 'Posts']);
    // sources are SUGGESTIONS: reported as unmet, never created
    expect((body.unmet as Array<{ kind: string }>).every((u) => u.kind === 'source')).toBe(true);
    expect(body.unmet.length).toBe(2);
    const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
    for (const name of ['Posts', 'Engagement', 'Metrics', 'Channels']) {
      const sources = await as('GET', `/workspaces/${ws}/databases/${dbs.find((d) => d.name === name)!.id}/sources`);
      expect(sources.statusCode, sources.body).toBe(200);
      expect((sources.json().data ?? sources.json()) as unknown[], `${name} must have no source`).toHaveLength(0);
    }
    for (const name of ['Posts', 'Engagement', 'Metrics']) {
      const rules = (await as('GET', `/workspaces/${ws}/databases/${dbs.find((d) => d.name === name)!.id}/automations`)).json();
      const list = (rules.data ?? rules) as Array<{ enabled: boolean; name: string }>;
      expect(list.length, name).toBeGreaterThanOrEqual(1);
      for (const r of list) expect(r.enabled, r.name).toBe(false);
    }

    // exercise every trigger the rules listen for; with all rules off, no run is recorded
    const posts = dbs.find((d) => d.name === 'Posts')!.id;
    const engagement = dbs.find((d) => d.name === 'Engagement')!.id;
    const post = (await as('POST', `/workspaces/${ws}/databases/${posts}/records`, { values: { name: 'probe' } })).json().id as string;
    await as('PATCH', `/workspaces/${ws}/databases/${posts}/records/${post}`, { values: { name: 'probe 2' } });
    await as('POST', `/workspaces/${ws}/databases/${engagement}/records`, { values: { name: 'a reply' } });
    const runs = await as('GET', `/workspaces/${ws}/runs`);
    expect(runs.statusCode, runs.body).toBe(200);
    expect((runs.json().data ?? runs.json()) as unknown[]).toHaveLength(0);
  });
});
