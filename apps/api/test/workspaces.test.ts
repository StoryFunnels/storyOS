import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Olena');
});

afterAll(async () => {
  await app.close();
});

describe('workspaces & tenancy (MN-008)', () => {
  it('creates a workspace with a default space and admin membership', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: authed(admin.token),
      payload: { name: 'JCM Agency' },
    });
    expect(res.statusCode).toBe(201);
    const ws = res.json();
    wsId = ws.id;
    expect(ws.slug).toBe('jcm-agency');

    const spaces = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/spaces`,
      headers: authed(admin.token),
    });
    expect(spaces.json().map((s: { name: string }) => s.name)).toEqual(['General']);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces',
      headers: authed(admin.token),
    });
    expect(mine.json().find((w: { id: string }) => w.id === wsId)?.role).toBe('admin');
  });

  it('rejects an invalid body with the 422 validation envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: authed(admin.token),
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details[0].path).toContain('name');
    expect(body.error.request_id).toBeTruthy();
  });

  it('returns 404 (not 403) for non-members', async () => {
    const stranger = await signUpUser(app, 'Stranger');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}`,
      headers: authed(stranger.token),
    });
    expect(res.statusCode).toBe(404);
  });

  describe('member invite flow', () => {
    let max: { token: string; email: string };

    it('admin invites a member; invite is acceptable; member sees the workspace', async () => {
      max = await signUpUser(app, 'Max');
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/invites`,
        headers: authed(admin.token),
        payload: { email: max.email, role: 'member' },
      });
      expect(invite.statusCode).toBe(201);
      const token = new URL(invite.json().accept_url).searchParams.get('token')!;

      const accept = await app.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        headers: authed(max.token),
        payload: { token },
      });
      expect(accept.statusCode).toBe(201);
      expect(accept.json().role).toBe('member');

      const ws = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${wsId}`,
        headers: authed(max.token),
      });
      expect(ws.statusCode).toBe(200);
    });

    it('an invite issued for another email cannot be accepted', async () => {
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/invites`,
        headers: authed(admin.token),
        payload: { email: 'someone-else@test.storyos.dev', role: 'member' },
      });
      const token = new URL(invite.json().accept_url).searchParams.get('token')!;
      const thief = await signUpUser(app, 'Thief');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        headers: authed(thief.token),
        payload: { token },
      });
      expect(res.statusCode).toBe(403);
    });

    it('members cannot invite (admin-only) but can create spaces', async () => {
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/invites`,
        headers: authed(max.token),
        payload: { email: 'x@test.storyos.dev', role: 'member' },
      });
      expect(invite.statusCode).toBe(403);

      const space = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/spaces`,
        headers: authed(max.token),
        payload: { name: 'Client Work' },
      });
      expect(space.statusCode).toBe(201);
    });
  });

  describe('guest scoping (ADR-0006)', () => {
    let dana: { token: string; email: string };
    let clientSpaceId: string;

    it('guest invites require space_ids', async () => {
      dana = await signUpUser(app, 'Dana');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/invites`,
        headers: authed(admin.token),
        payload: { email: dana.email, role: 'guest' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details[0].path).toContain('grants');
    });

    it('scoped guest sees only their spaces and cannot write', async () => {
      const spaces = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${wsId}/spaces`,
        headers: authed(admin.token),
      });
      clientSpaceId = spaces.json().find((s: { name: string }) => s.name === 'Client Work').id;

      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/invites`,
        headers: authed(admin.token),
        payload: { email: dana.email, role: 'guest', grants: [{ space_id: clientSpaceId, role: 'commenter' }] },
      });
      const token = new URL(invite.json().accept_url).searchParams.get('token')!;
      await app.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        headers: authed(dana.token),
        payload: { token },
      });

      const visible = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${wsId}/spaces`,
        headers: authed(dana.token),
      });
      expect(visible.json().map((s: { id: string }) => s.id)).toEqual([clientSpaceId]);

      const write = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/spaces`,
        headers: authed(dana.token),
        payload: { name: 'Nope' },
      });
      expect(write.statusCode).toBe(403);

      const settings = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${wsId}/members`,
        headers: authed(dana.token),
      });
      expect(settings.statusCode).toBe(403);
    });
  });

  describe('last-admin protection', () => {
    it('the last admin cannot demote or remove themselves', async () => {
      const members = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${wsId}/members`,
        headers: authed(admin.token),
      });
      const self = members
        .json()
        .find((m: { role: string; user: { email: string } }) => m.user.email === admin.email);

      const demote = await app.inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${wsId}/members/${self.id}`,
        headers: authed(admin.token),
        payload: { role: 'member' },
      });
      expect(demote.statusCode).toBe(409);

      const remove = await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${wsId}/members/${self.id}`,
        headers: authed(admin.token),
      });
      expect(remove.statusCode).toBe(409);
    });
  });
});
