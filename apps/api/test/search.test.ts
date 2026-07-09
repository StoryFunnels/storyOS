import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let spaceAId: string;

async function inject(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Searcher');
  guest = await signUpUser(app, 'GuestSeeker');
  wsId = (await inject(admin.token, 'POST', '/workspaces', { name: 'Search WS' })).json().id;
  spaceAId = (await inject(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const spaceB = (await inject(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Secret' })).json();

  const dbA = (await inject(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceAId, name: 'Open Tasks' })).json();
  const dbB = (await inject(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceB.id, name: 'Secret Plans' })).json();
  await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbA.id}/records`, { values: { name: 'Phoenix launch checklist' } });
  await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbB.id}/records`, { values: { name: 'Phoenix secret roadmap' } });

  // Guest gets a viewer grant on space A only.
  const invite = await inject(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email, role: 'guest', grants: [{ space_id: spaceAId, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await inject(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('global search (MN-048)', () => {
  it('finds records by title with database context for members', async () => {
    const res = await inject(admin.token, 'GET', `/workspaces/${wsId}/search?q=phoenix`);
    expect(res.statusCode, res.body).toBe(200);
    const titles = res.json().records.map((r: { title: string }) => r.title);
    expect(titles).toContain('Phoenix launch checklist');
    expect(titles).toContain('Phoenix secret roadmap');
  });

  it('scopes guests to granted spaces', async () => {
    const res = await inject(guest.token, 'GET', `/workspaces/${wsId}/search?q=phoenix`);
    expect(res.statusCode, res.body).toBe(200);
    const titles = res.json().records.map((r: { title: string }) => r.title);
    expect(titles).toContain('Phoenix launch checklist');
    expect(titles).not.toContain('Phoenix secret roadmap');
  });

  it('matches databases as places and returns recents from activity', async () => {
    const res = await inject(admin.token, 'GET', `/workspaces/${wsId}/search?q=secret`);
    expect(res.json().places.some((p: { name: string }) => p.name === 'Secret Plans')).toBe(true);

    const recent = await inject(admin.token, 'GET', `/workspaces/${wsId}/recent`);
    expect(recent.statusCode).toBe(200);
    expect(recent.json().records.length).toBeGreaterThanOrEqual(1);
  });
});
