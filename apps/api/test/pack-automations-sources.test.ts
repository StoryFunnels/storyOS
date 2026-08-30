/**
 * #455 — a pack can ship disabled rules and suggest the sources it needs.
 *
 * The safety properties, in order of how much they would cost to get wrong:
 *  1. An installed rule is OFF. A pack that switches on a rule in someone
 *     else's workspace is the worst thing this feature could do.
 *  2. Installing never creates a source. A source needs a connection the
 *     workspace may not have, and one that cannot authenticate is a broken
 *     integration nobody asked for.
 *  3. A rule cannot be enabled into a runtime failure — refusing names what is
 *     missing while the person is still looking at the switch.
 *  4. The seven packs that exist install exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { TemplatesService } from '../src/templates/templates.service';
import { AutomationsService } from '../src/automations/automations.service';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automations } from '../src/db/schema';
import { TEMPLATES } from '../src/templates/definitions';
import type { TemplateDef } from '../src/templates/types';

let app: NestFastifyApplication;
let templates: TemplatesService;
let engine: AutomationsService;
let db: Db;
let admin: { token: string };
let wsId: string;
let membership: never;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

/** A pack that exists only for this test, pushed onto the real registry. */
const FIXTURE: TemplateDef = {
  slug: 'test-455-pack',
  name: 'Test 455 Pack',
  description: 'Fixture pack for #455.',
  category: 'agency',
  scope: 'pack',
  space: 'Pack 455',
  databases: [
    {
      key: 'posts',
      name: 'Posts455',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [{ label: 'Draft' }, { label: 'Live' }] },
        { key: 'notes', display_name: 'Notes', type: 'text' },
      ],
    },
  ] as never,
  relations: [],
  views: [],
  records: [],
  automations: [
    {
      database: 'posts',
      name: 'Announce when live',
      trigger: { type: 'record_updated', field: 'status' },
      actions: [{ type: 'add_comment', body_template: 'Now live: {Title}' }],
      enabled: false,
      requires_connections: ['slack'],
    },
    {
      database: 'posts',
      name: 'Stamp a note',
      trigger: { type: 'record_created' },
      actions: [{ type: 'add_comment', body_template: 'Created' }],
      enabled: false,
    },
  ],
  suggested_sources: [
    { provider: 'apify', description: 'Pulls competitor posts into Posts455.', database: 'posts' },
  ],
};

beforeAll(async () => {
  app = await createTestApp();
  templates = app.get(TemplatesService);
  engine = app.get(AutomationsService);
  db = app.get<Db>(DB);
  admin = await signUpUser(app, 'Packer455');
  wsId = (await inject('POST', '/workspaces', { name: 'Pack455 WS' })).json().id;
  const members = (await inject('GET', `/workspaces/${wsId}/members`)).json();
  membership = { workspaceId: wsId, userId: members[0].user_id, role: 'admin' } as never;
  TEMPLATES.push(FIXTURE);
});

afterAll(async () => {
  const i = TEMPLATES.indexOf(FIXTURE);
  if (i >= 0) TEMPLATES.splice(i, 1);
  await app.close();
});

describe('#455 — packs carry automations and suggest sources', () => {
  let installed: Awaited<ReturnType<TemplatesService['apply']>>;

  it('installs the pack rules DISABLED, and creates no source', async () => {
    const me = (await inject('GET', `/workspaces/${wsId}/members`)).json()[0].user_id;
    installed = await templates.apply(membership, 'test-455-pack', me, { include_samples: false });

    expect(installed.automations).toHaveLength(2);
    const rows = await db.query.automations.findMany({
      where: eq(automations.id, installed.automations[0]!),
    });
    expect(rows).toHaveLength(1);

    for (const id of installed.automations) {
      const rule = (await db.query.automations.findFirst({ where: eq(automations.id, id) }))!;
      expect(rule.enabled, `"${rule.name}" must install switched off`).toBe(false);
    }

    // Suggested, never created.
    expect(installed.suggested_sources).toEqual([
      { provider: 'apify', description: 'Pulls competitor posts into Posts455.', database_id: expect.any(String) },
    ]);
    const sources = await inject('GET', `/workspaces/${wsId}/sources`);
    const list = sources.statusCode < 300 ? (sources.json().data ?? sources.json()) : [];
    expect(list, 'installing a pack must not create a source').toHaveLength(0);

    // The notes tell the installer what was left switched off, and why.
    expect(installed.notes.join('\n')).toContain('needs slack connected');
    expect(installed.notes.join('\n')).toContain('not created');
  });

  it('refuses to enable a pack rule whose connection is missing, and names it', async () => {
    const needsSlack = installed.automations[0]!;
    const rule = (await db.query.automations.findFirst({ where: eq(automations.id, needsSlack) }))!;
    expect(rule.requiresConnections).toEqual(['slack']);

    await expect(
      engine.update(wsId, rule.databaseId, rule.id, { enabled: true }, 'someone'),
    ).rejects.toThrow(/slack/i);

    // Still off — a refused enable must not half-apply.
    const after = (await db.query.automations.findFirst({ where: eq(automations.id, needsSlack) }))!;
    expect(after.enabled).toBe(false);
  });

  it('a rule that declares no connection enables normally', async () => {
    const plain = installed.automations[1]!;
    const rule = (await db.query.automations.findFirst({ where: eq(automations.id, plain) }))!;
    expect(rule.requiresConnections).toEqual([]);
    await engine.update(wsId, rule.databaseId, rule.id, { enabled: true }, 'someone');
    const after = (await db.query.automations.findFirst({ where: eq(automations.id, plain) }))!;
    expect(after.enabled).toBe(true);
  });

  it('MUST KEEP WORKING: the seven shipped packs declare neither field and install unchanged', async () => {
    const shipped = TEMPLATES.filter((t) => t.slug !== 'test-455-pack');
    expect(shipped.length).toBeGreaterThanOrEqual(7);
    expect(
      shipped.every((t) => t.automations === undefined && t.suggested_sources === undefined),
      'no shipped pack declares the new fields yet',
    ).toBe(true);

    const me = (await inject('GET', `/workspaces/${wsId}/members`)).json()[0].user_id;
    const res = await templates.apply(membership, 'client-work', me, { include_samples: true });
    expect(res.automations, 'a pack with no rules installs none').toEqual([]);
    expect(res.suggested_sources).toEqual([]);
    expect(res.sample_records).toBeGreaterThan(0);
  });
});
