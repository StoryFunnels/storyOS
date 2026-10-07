import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { STARTER_PACKS } from '../src/packs/starter-packs';

/**
 * #749 — `packs.service.ts` seeded sample records but never registered them
 * into `workspace.settings.sample_record_ids`, the ONE registry
 * `templates.service.ts` already writes to and `"Remove sample data"`/the
 * onboarding checklist already read from. Three consequences, all verified
 * here: the pack-seeded records could not be removed, they satisfied the
 * onboarding "add a record" step the user never actually did, and (by
 * extension, on the same live data) any established-workspace check reading
 * this registry would be lied to. Fixed by sharing the SAME tracking
 * function (`trackSampleRecords`) `TemplatesService` already used, rather
 * than a second copy of the read-modify-write.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function newWorkspace(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/workspaces', { name: `${name} ${Date.now()}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

const agencyOs = STARTER_PACKS.find((p) => p.slug === 'agency-os')!;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PackSampleTrackingAdmin');
});

afterAll(async () => {
  await app.close();
});

describe('#749 — pack-seeded sample records are registered and behave like template samples', () => {
  it('AC3(a): "Remove sample data" actually deletes pack-seeded records, count non-zero', async () => {
    const wsId = await newWorkspace('749a');
    const install = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, { manifest: agencyOs.manifest });
    expect(install.statusCode, install.body).toBe(201);
    const created = install.json().sample_records.filter((r: { action: string }) => r.action === 'created');
    expect(created.length).toBeGreaterThan(0);

    const removed = await as(admin.token, 'DELETE', `/workspaces/${wsId}/templates/sample-data`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().removed).toBe(created.length);

    // Confirmed gone, not just reported gone: a second removal has nothing
    // left (the registry itself was cleared), AND the Clients database
    // (which holds "Acme Co (sample)") no longer lists it.
    const secondRemoval = await as(admin.token, 'DELETE', `/workspaces/${wsId}/templates/sample-data`);
    expect(secondRemoval.json().removed).toBe(0);
    const dbList = await as(admin.token, 'GET', `/workspaces/${wsId}/databases`);
    const clients = (dbList.json() as Array<{ id: string; name: string }>).find((d) => d.name === 'Clients')!;
    const remaining = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${clients.id}/records`);
    expect(remaining.json().data).toEqual([]);
  });

  it('AC3(b): the onboarding checklist\'s "add a record" step stays UNTICKED after installing a pack with only sample records', async () => {
    const wsId = await newWorkspace('749b');
    const install = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, { manifest: agencyOs.manifest });
    expect(install.statusCode, install.body).toBe(201);
    expect(install.json().sample_records.length).toBeGreaterThan(0);

    const onboarding = await as(admin.token, 'GET', `/workspaces/${wsId}/onboarding`);
    expect(onboarding.statusCode, onboarding.body).toBe(200);
    expect(onboarding.json().records_added).toBe(false);
  });

  it('MUST KEEP WORKING: creating a genuine user record after a pack install DOES tick "add a record"', async () => {
    const wsId = await newWorkspace('749c');
    await as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, { manifest: agencyOs.manifest });
    const dbList = await as(admin.token, 'GET', `/workspaces/${wsId}/databases`);
    const clients = (dbList.json() as Array<{ id: string; name: string }>).find((d) => d.name === 'Clients')!;
    const real = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${clients.id}/records`, {
      values: { name: 'A real client, typed by the user' },
    });
    expect(real.statusCode, real.body).toBe(201);

    const onboarding = await as(admin.token, 'GET', `/workspaces/${wsId}/onboarding`);
    expect(onboarding.json().records_added).toBe(true);
  });

  it('AC2 — identity is the id this install produced, never a title match: a pre-existing user record sharing a sample\'s title is NOT registered as a sample and survives "Remove sample data"', async () => {
    const wsId = await newWorkspace('749d');
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const clientsDb = await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' });
    // Pre-create a record with the EXACT title one of agency-os's own samples
    // uses, before the pack ever installs — this is a genuine user record
    // that happens to collide on title, which the install's own reuse-by-
    // title logic will match rather than create a duplicate for.
    const preExisting = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${clientsDb.json().id}/records`, {
      values: { name: 'Acme Co (sample)' },
    });
    expect(preExisting.statusCode, preExisting.body).toBe(201);

    const install = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, {
      manifest: agencyOs.manifest,
      resolutions: { Clients: { action: 'reuse' } },
    });
    expect(install.statusCode, install.body).toBe(201);
    const acmeEntry = install.json().sample_records.find((r: { name: string }) => r.name.includes('Acme Co'));
    expect(acmeEntry, JSON.stringify(install.json().sample_records)).toBeTruthy();
    expect(acmeEntry.action).toBe('reused');
    expect(acmeEntry.id).toBe(preExisting.json().id);

    // "Remove sample data" must not delete the user's own pre-existing record.
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/templates/sample-data`);
    const stillThere = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${clientsDb.json().id}/records/${preExisting.json().id}`);
    expect(stillThere.statusCode, stillThere.body).toBe(200);
  });

  it('MUST KEEP WORKING: the template flow\'s own tracking and removal is unaffected by the shared function', async () => {
    const wsId = await newWorkspace('749e');
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/templates/solo-dev/apply`, {});
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().sample_records).toBeGreaterThan(0);

    const removed = await as(admin.token, 'DELETE', `/workspaces/${wsId}/templates/sample-data`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().removed).toBe(res.json().sample_records);
  });
});
