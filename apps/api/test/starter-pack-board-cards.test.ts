import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { fieldRef } from '@storyos/schemas';
import { STARTER_PACKS } from '../src/packs/starter-packs';

/**
 * ticket #1012 — the Dev Project OS board shipped title-only cards (no `card_field_ids`), and so did every other built-in pack's board.
 * Every board view in every starter pack now lists the card fields a person scans a board for, and a fresh install shows them.
 * Existing installs are NOT changed: an install reuses a view that already exists by name and never rewrites it.
 */
let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Board Cards');
}, 240_000);
afterAll(async () => { await app.close(); });

const boards = STARTER_PACKS.flatMap((p) => p.manifest.views.filter((v) => v.type === 'board').map((v) => ({ slug: p.slug, view: v, manifest: p.manifest })));

describe('#1012 every starter pack board lists card fields', () => {
  it('there are boards to check (a guard against the loop below passing on an empty list)', () => {
    expect(boards.length).toBeGreaterThanOrEqual(14);
  });

  it('no card lists a URL, rich-text or sentence-length free-text field (a link or a sentence on every card is noise; a short name like Show / Event is fine)', () => {
    for (const b of boards) {
      const db = b.manifest.databases.find((d) => d.name === b.view.database)!;
      for (const ref of (b.view.config as { card_field_ids: string[] }).card_field_ids) {
        const f = db.fields.find((x) => fieldRef(db.name, x.name) === ref);
        if (f) {
          expect(['url', 'rich_text'], `${b.slug}/${b.view.name}: ${f.name}`).not.toContain(f.type);
          expect(['POV / Theme', 'Goal'], `${b.slug}/${b.view.name}: ${f.name} is a sentence`).not.toContain(f.name);
        }
      }
    }
  });

  for (const b of boards) {
    it(`${b.slug}: ${b.view.database}.${b.view.name} lists card fields that exist in its database`, () => {
      const cfg = b.view.config as { card_field_ids?: string[]; group_by_field_id?: string };
      expect(cfg.card_field_ids, 'no card_field_ids: title-only cards').toBeTruthy();
      expect(cfg.card_field_ids!.length).toBeGreaterThan(0);
      expect(new Set(cfg.card_field_ids).size, 'no field twice').toBe(cfg.card_field_ids!.length);
      expect(cfg.card_field_ids, 'the grouped field is the column: the board never shows it on a card, so listing it is a dead slot').not.toContain(cfg.group_by_field_id);
      expect(cfg.card_field_ids!.length, '2–3 fields: the ones acted on at a glance').toBeLessThanOrEqual(3);
      const db = b.manifest.databases.find((d) => d.name === b.view.database)!;
      const known = new Set([
        ...db.fields.map((f) => f.name),
        ...b.manifest.states.filter((st) => st.database === db.name).map((st) => st.field),
        ...b.manifest.derived_fields.filter((f) => f.database === db.name).map((f) => f.name),
      ].map((n) => fieldRef(db.name, n)));
      // a relation adds a field on each side (what `PacksService` resolves refs against), and a relation field is a valid card field
      for (const r of b.manifest.relations) {
        known.add(fieldRef(r.from, r.from_field));
        known.add(fieldRef(r.to, r.to_field));
      }
      for (const ref of cfg.card_field_ids!) expect(known.has(ref), `${ref} names a field of ${db.name}`).toBe(true);
    });
  }
});

describe('#1012 a fresh install shows the fields on the cards', () => {
  it('every installed board of every pack has real field ids (relation fields included), and the reviewed boards show exactly Dara\'s fields', async () => {
    for (const p of STARTER_PACKS) {
      const ws = (await as('POST', '/workspaces', { name: `Cards ${p.slug}` })).json().id as string;
      const pack = (await as('GET', `/packs/registry/${p.slug}`)).json() as { manifest: unknown };
      const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: pack.manifest });
      expect(res.statusCode, `${p.slug}: ${res.body}`).toBe(201);
      const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
      for (const b of boards.filter((x) => x.slug === p.slug)) {
        const detail = (await as('GET', `/workspaces/${ws}/databases/${dbs.find((d) => d.name === b.view.database)!.id}`)).json() as {
          fields: Array<{ id: string; displayName: string }>;
          views: Array<{ name: string; type: string; config: { card_field_ids?: string[]; group_by_field_id?: string } }>;
        };
        const view = detail.views.find((v) => v.name === b.view.name)!;
        const names = (view.config.card_field_ids ?? []).map((id) => detail.fields.find((f) => f.id === id)?.displayName);
        expect(names.length, `${p.slug}/${b.view.name}`).toBeGreaterThan(0);
        expect(names.every(Boolean), `${p.slug}/${b.view.name}: every card field id is a real field: ${JSON.stringify(names)}`).toBe(true);
        const expected: Record<string, string[]> = {
          'dev-project-os/Issue Board': ['Type', 'Priority', 'Assignee'],
          'client-portal/Shared Board': ['Assignee', 'Due Date', 'Client Approval'],
          'coaching-os/Session Board': ['Client', 'Date', 'Type'],
          'coaching-os/Client Board': ['Program', 'Renewal Date'],
          'consulting-os/Pipeline Board': ['Client', 'Value', 'Expected Close'],
          'consulting-os/Engagement Board': ['Client', 'End Date', 'Monthly Value'],
        };
        const want = expected[`${p.slug}/${b.view.name}`];
        if (want) expect(names, `${p.slug}/${b.view.name}`).toEqual(want);
      }
    }
  }, 300_000);

  it('existing installs are NOT changed: installing again never rewrites a view that already exists', async () => {
    const ws = (await as('POST', '/workspaces', { name: 'Cards reinstall' })).json().id as string;
    const pack = (await as('GET', '/packs/registry/dev-project-os')).json() as { manifest: unknown };
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: pack.manifest })).statusCode).toBe(201);
    const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
    const issues = dbs.find((d) => d.name === 'Issues')!.id;
    const view = () => as('GET', `/workspaces/${ws}/databases/${issues}`).then((r) => (r.json().views as Array<{ id: string; name: string; config: { card_field_ids?: string[] } }>).find((v) => v.name === 'Issue Board')!);
    const before = await view();
    // an install from before this change: the view exists with no card fields (a person may have chosen exactly that)
    expect((await as('PATCH', `/workspaces/${ws}/databases/${issues}/views/${before.id}`, { config: { ...before.config, card_field_ids: [] } })).statusCode).toBe(200);
    expect((await view()).config.card_field_ids).toEqual([]);
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: pack.manifest })).statusCode).toBe(201);
    expect((await view()).config.card_field_ids, 'the reinstall left the existing view alone').toEqual([]);
  });
});
