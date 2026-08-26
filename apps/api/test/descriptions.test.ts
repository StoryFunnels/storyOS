import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DESCRIPTION_MAX, normalizeDescription } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #400 — a workspace, a space and a database each carry a one-line purpose.
 *
 * The ticket's own acceptance note is the reason this file exists at all: "a
 * description that exists but is not returned by the listing tools is a failed
 * acceptance". So every level is asserted on the way OUT, not just on the way in.
 */

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Describer');
  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'Described WS', description: 'What this company is doing here.' },
  });
  wsId = ws.json().id;
  const spaces = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
  });
  spaceId = spaces.json()[0].id;
});

afterAll(async () => {
  await app?.close();
});

const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: authed(admin.token), payload });

describe('the purpose line survives a round trip at all three levels', () => {
  it('a workspace keeps the description it was created with', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces',
      headers: authed(admin.token),
    });
    const mine = res.json().find((w: { id: string }) => w.id === wsId);
    expect(mine.description).toBe('What this company is doing here.');
  });

  it('a space accepts one and returns it in the listing', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/spaces`,
      headers: authed(admin.token),
      payload: { name: 'Client Work', description: 'Everything we do for paying clients.' },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/spaces`,
      headers: authed(admin.token),
    });
    const space = list.json().find((s: { name: string }) => s.name === 'Client Work');
    expect(space.description).toBe('Everything we do for paying clients.');
  });

  it('a database accepts one and returns it from BOTH the listing and the detail', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: {
        space_id: spaceId,
        name: 'Voices',
        description: 'Tone-of-voice profiles we write in, one per publication.',
      },
    });
    const dbId = created.json().id;

    // The listing — what an agent reads before choosing a target.
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
    });
    const listed = list.json().find((d: { id: string }) => d.id === dbId);
    expect(listed.description).toBe('Tone-of-voice profiles we write in, one per publication.');

    // The detail — what describe_database is built from.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}`,
      headers: authed(admin.token),
    });
    expect(detail.json().description).toBe(
      'Tone-of-voice profiles we write in, one per publication.',
    );
  });
});

describe('editing it', () => {
  let dbId: string;

  beforeAll(async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: spaceId, name: 'Editable', description: 'First attempt.' },
    });
    dbId = created.json().id;
  });

  it('null CLEARS it, rather than being ignored or stored as the string "null"', async () => {
    const res = await patch(`/api/v1/workspaces/${wsId}/databases/${dbId}`, { description: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBeNull();
  });

  it('omitting the key leaves the existing description ALONE', async () => {
    await patch(`/api/v1/workspaces/${wsId}/databases/${dbId}`, { description: 'Second attempt.' });
    // A rename that says nothing about the description must not wipe it — the
    // commonest way a nullable patch field gets silently destroyed.
    const res = await patch(`/api/v1/workspaces/${wsId}/databases/${dbId}`, { name: 'Renamed' });
    expect(res.json().name).toBe('Renamed');
    expect(res.json().description).toBe('Second attempt.');
  });

  it('rejects one longer than the cap instead of silently truncating it', async () => {
    const res = await patch(`/api/v1/workspaces/${wsId}/databases/${dbId}`, {
      description: 'x'.repeat(DESCRIPTION_MAX + 1),
    });
    // 422, the API's validation status — not 400. Asserted so a change in the
    // cap cannot quietly start truncating instead of refusing.
    expect(res.statusCode).toBe(422);
  });
});

describe('no description is a NORMAL state, not a broken one', () => {
  it('a database created without one has null, not an empty string', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: spaceId, name: 'Undescribed' },
    });
    /*
     * The distinction matters downstream: every surface renders the description
     * conditionally, and `''` is falsy in JSX but truthy in a `!= null` check.
     * Pinning it to null keeps "absent" ONE state rather than two that behave
     * differently depending on which test a reader happens to write (#305).
     */
    expect(created.json().description).toBeNull();
  });
});

describe('normalizeDescription — the service-layer choke point', () => {
  it('collapses a pasted multi-line string to one line', () => {
    // The field is called a "one-liner" and renders in a tooltip sized for one.
    expect(normalizeDescription('Tone of voice\n\nprofiles   we write in')).toBe(
      'Tone of voice profiles we write in',
    );
  });

  it('turns whitespace-only into null — clearing the box means clearing it', () => {
    expect(normalizeDescription('   \n  ')).toBeNull();
    expect(normalizeDescription('')).toBeNull();
  });

  it('distinguishes undefined (leave alone) from null (clear)', () => {
    // These two are NOT interchangeable: a patch that omits the key must not
    // clear the column, and the whole update path depends on this asymmetry.
    expect(normalizeDescription(undefined)).toBeUndefined();
    expect(normalizeDescription(null)).toBeNull();
  });

  it('never returns more than the cap, even if a direct caller bypasses zod', () => {
    // Packs, templates and the Architect call the services directly — the DTO's
    // .max() never runs for them, which is exactly why the bound is repeated here.
    expect(normalizeDescription('y'.repeat(500))).toHaveLength(DESCRIPTION_MAX);
  });
});
