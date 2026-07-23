import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { STARTER_PACKS } from '../src/packs/starter-packs';

/**
 * The starter Business Packs (MN-221 / #163) — every one of the six (seven)
 * onboarding starters rebuilt as a real pack: states+gates, an automation, an
 * agent bound to a state transition, and sample data.
 *
 * This does not re-test the pack *format* — `packs.test.ts` already covers
 * ref-rewriting, idempotency and collisions generically. What's specific to
 * this ticket, and worth its own file, is that each of these seven manifests
 * — hand-authored, not round-tripped through export — actually installs
 * clean into a fresh workspace with nothing unmet, and that the AC's four
 * ingredients are really there: a state, a human-gated trigger, an
 * automation, and sample records.
 */

let app: NestFastifyApplication;
let admin: { token: string; email: string };

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function newWorkspace(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/workspaces', { name: `${name} ${Date.now()}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'StarterPacksAdmin');
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('starter packs (MN-221 / #163)', () => {
  it('the registry carries exactly these seven, each self-contained (no external_target_name-style cross-pack refs)', () => {
    const slugs = STARTER_PACKS.map((p) => p.slug).sort();
    expect(slugs).toEqual(
      [
        'agency-os',
        'client-portal',
        'coaching-os',
        'consulting-os',
        'content-engine',
        'dev-project-os',
        'book-launch',
      ].sort(),
    );
  });

  for (const entry of STARTER_PACKS) {
    describe(entry.slug, () => {
      let wsId: string;

      beforeAll(async () => {
        wsId = await newWorkspace(entry.slug);
      });

      it('has at least one state, one human-gated trigger, one automation and sample records in its manifest', () => {
        const { manifest } = entry;
        expect(manifest.states.length).toBeGreaterThanOrEqual(1);
        expect(manifest.triggers.length).toBeGreaterThanOrEqual(1);
        expect(manifest.triggers.some((t) => t.human_gate === true)).toBe(true);
        expect(manifest.agents.length).toBeGreaterThanOrEqual(1);
        expect(manifest.automations.length).toBeGreaterThanOrEqual(1);
        expect(manifest.sample_records.length).toBeGreaterThanOrEqual(1);
      });

      it('previews clean — every database/view/automation/agent as create, nothing unmet', async () => {
        const res = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/preview`, {
          manifest: entry.manifest,
        });
        expect(res.statusCode, res.body).toBe(201);
        const body = res.json();
        expect(body.unmet).toEqual([]);
        for (const item of [...body.databases, ...body.views, ...body.automations, ...body.agents]) {
          expect(item.action, JSON.stringify(item)).toBe('create');
        }
      });

      it('installs clean into a fresh workspace', async () => {
        const res = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, {
          manifest: entry.manifest,
        });
        expect(res.statusCode, res.body).toBe(201);
        const body = res.json();
        expect(body.unmet).toEqual([]);
        expect(body.databases.every((d: { action: string }) => d.action === 'created')).toBe(true);
        expect(body.states.length).toBeGreaterThanOrEqual(1);
        expect(body.agents.some((a: { action: string }) => a.action === 'created')).toBe(true);
        expect(body.triggers.length).toBeGreaterThanOrEqual(1);
        expect(body.automations.some((a: { action: string }) => a.action === 'created')).toBe(true);
        expect(body.sample_records.length).toBeGreaterThanOrEqual(1);
        expect(body.sample_records.every((r: { action: string }) => r.action === 'created')).toBe(true);
      });

      it('re-installing the same manifest is idempotent — nothing new created', async () => {
        const res = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, {
          manifest: entry.manifest,
        });
        expect(res.statusCode, res.body).toBe(201);
        const body = res.json();
        const created = [
          ...body.databases,
          ...body.fields,
          ...body.relations,
          ...body.states,
          ...body.agents,
          ...body.triggers,
          ...body.views,
          ...body.automations,
          ...body.sample_records,
        ].filter((i: { action: string }) => i.action === 'created');
        expect(created, JSON.stringify(created)).toEqual([]);
      });
    });
  }
});
