import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { resolveSampleDate, sampleDate, sampleRef } from '@storyos/schemas';
import { STARTER_PACKS } from '../src/packs/starter-packs';

/**
 * ticket #1015 — the starter packs' boards list card fields (ticket #1012), but their sample records filled none of them, so cards were
 * still title-only right after install: the first impression the activation funnel depends on. Every starter pack's sample records now
 * fill the fields its boards show, spread the board's columns, carry due dates (one in the past, so something reads overdue), and put the
 * person installing on every person field. All of it is plainly sample data and goes away with "Remove sample data".
 */
let app: NestFastifyApplication;
let owner: { token: string; id: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  const u = await signUpUser(app, 'Sample Cards');
  owner = { token: u.token, id: (await call(app, u.token, 'GET', '/me')).json().id };
}, 240_000);
afterAll(async () => { await app.close(); });

type Field = { id: string; displayName: string; apiName: string; type: string };
type Rec = { id: string; title: string; values: Record<string, unknown> };
type Detail = { fields: Field[]; views: Array<{ name: string; type: string; config: { card_field_ids?: string[]; group_by_field_id?: string } }> };

const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
const today = () => new Date().toISOString().slice(0, 10);

describe('#1015 the sample tokens', () => {
  it('a date token is today plus or minus N days, in UTC', () => {
    const now = new Date('2026-10-21T23:30:00Z');
    expect(resolveSampleDate('$date:+0d', now)).toBe('2026-10-21');
    expect(resolveSampleDate('$date:+3d', now)).toBe('2026-10-24');
    expect(resolveSampleDate('$date:-2d', now)).toBe('2026-10-19');
    expect(resolveSampleDate('$date:-30d', now)).toBe('2026-09-21');
    expect(resolveSampleDate('2026-10-21', now), 'a plain date is not a token').toBeNull();
    expect(sampleDate(-2)).toBe('$date:-2d');
    expect(sampleDate(5)).toBe('$date:+5d');
    expect(sampleRef('Clients', 'Acme (sample)')).toBe('$sample:Clients/Acme (sample)');
  });
});

describe('#1015 a fresh install of every starter pack looks like the design', () => {
  for (const pack of STARTER_PACKS) {
    it(`${pack.slug}: every board's card fields are filled, its columns are spread, dates and assignees are real`, async () => {
      const ws = (await as('POST', '/workspaces', { name: `Cards ${pack.slug}` })).json().id as string;
      const manifest = (await as('GET', `/packs/registry/${pack.slug}`)).json() as { manifest: unknown };
      const install = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: manifest.manifest });
      expect(install.statusCode, install.body).toBe(201);
      expect(install.json().skipped_sample_field_values, 'every token and ref resolved').toEqual([]);
      const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;

      const dates: string[] = [];
      const boards = pack.manifest.views.filter((v) => v.type === 'board');
      expect(boards.length).toBeGreaterThan(0);
      for (const board of boards) {
        const dbId = dbs.find((d) => d.name === board.database)!.id;
        const detail = (await as('GET', `/workspaces/${ws}/databases/${dbId}`)).json() as Detail;
        const view = detail.views.find((v) => v.name === board.name)!;
        const cards = (await as('POST', `/workspaces/${ws}/databases/${dbId}/records/query`, { limit: 100 })).json().data as Rec[];
        const label = `${pack.slug} / ${board.name}`;
        expect(cards.length, `${label}: sample cards`).toBeGreaterThanOrEqual(3);

        // a raw token must never reach a record
        expect(JSON.stringify(cards), `${label}: no unresolved token`).not.toMatch(/\$(me|date:|sample:)/);

        // every card field is non-empty on at least half of the cards
        const cardFields = (view.config.card_field_ids ?? []).map((id) => detail.fields.find((f) => f.id === id)!);
        for (const f of cardFields) {
          const n = cards.filter((c) => filled(c.values[f.apiName])).length;
          expect(n / cards.length, `${label}: ${f.displayName} is filled on ${n} of ${cards.length} cards`).toBeGreaterThanOrEqual(0.5);
          if (f.type === 'user') for (const c of cards) expect(c.values[f.apiName], `${label}: ${f.displayName} on "${c.title}" is the installer`).toBe(owner.id);
          if (f.type === 'date') for (const c of cards) if (filled(c.values[f.apiName])) dates.push(String(c.values[f.apiName]).slice(0, 10));
        }

        // the grouped field is spread over several columns
        const group = detail.fields.find((f) => f.id === view.config.group_by_field_id)!;
        const columns = new Set(cards.map((c) => JSON.stringify(c.values[group.apiName] ?? null)));
        expect(columns.size, `${label}: ${group.displayName} spreads over ${columns.size} columns`).toBeGreaterThanOrEqual(3);
      }
      if (dates.length > 0) {
        expect(dates.some((d) => d < today()), `${pack.slug}: one date in the past (reads overdue)`).toBe(true);
        expect(dates.some((d) => d >= today()), `${pack.slug}: a date still ahead`).toBe(true);
      }
    });
  }

  it('it is all sample data: every created record is titled "(sample)" and Remove sample data clears them, relations included', async () => {
    const ws = (await as('POST', '/workspaces', { name: 'Cards removal' })).json().id as string;
    const pack = STARTER_PACKS.find((p) => p.slug === 'coaching-os')!;
    const manifest = (await as('GET', `/packs/registry/${pack.slug}`)).json() as { manifest: unknown };
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: manifest.manifest })).statusCode).toBe(201);
    const names = new Set(pack.manifest.databases.map((d) => d.name));
    const dbs = ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>).filter((d) => names.has(d.name)); // the pack's own databases (Members and Agents are system databases)
    const all = async () => (await Promise.all(dbs.map(async (d) => (await as('POST', `/workspaces/${ws}/databases/${d.id}/records/query`, { limit: 100 })).json().data as Rec[]))).flat();
    const before = await all();
    expect(before.length).toBeGreaterThan(8);
    expect(before.every((r) => r.title.endsWith('(sample)')), 'plainly sample data').toBe(true);
    expect((await as('DELETE', `/workspaces/${ws}/templates/sample-data`)).statusCode).toBeLessThan(300);
    expect(await all(), 'nothing is left').toEqual([]);
  });

  it('installing the same pack again adds no second set of sample records (they are matched by title)', async () => {
    const ws = (await as('POST', '/workspaces', { name: 'Cards reinstall' })).json().id as string;
    const manifest = (await as('GET', `/packs/registry/agency-os`)).json() as { manifest: unknown };
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: manifest.manifest })).statusCode).toBe(201);
    const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
    const tasks = dbs.find((d) => d.name === 'Tasks')!.id;
    const count = async () => ((await as('POST', `/workspaces/${ws}/databases/${tasks}/records/query`, { limit: 100 })).json().data as Rec[]).length;
    const first = await count();
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: manifest.manifest })).statusCode).toBe(201);
    expect(await count()).toBe(first);
  });
});
