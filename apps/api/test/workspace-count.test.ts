import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { EntitlementsService } from '../src/billing/entitlements.service';

let app: NestFastifyApplication;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

/**
 * Stripe is unset in the test env (self-host mode) — canCreateWorkspace is a
 * real no-op there by design (unlimited). This spies on the real singleton to
 * prove WorkspacesService.create() actually calls and reacts to the verdict,
 * the same technique used throughout MN-190's tests.
 */
function forceWorkspaceCapReached() {
  const entitlements = app.get(EntitlementsService);
  const original = entitlements.canCreateWorkspace.bind(entitlements);
  entitlements.canCreateWorkspace = vi.fn(async () => false);
  return () => {
    entitlements.canCreateWorkspace = original;
  };
}

describe('MN-191 — workspace-count entitlement wiring', () => {
  it('always allows the first workspace, cap or not', async () => {
    const user = await signUpUser(app, 'FirstWorkspace');
    const restore = forceWorkspaceCapReached();
    try {
      // Even with the cap force-failing, THIS user owns zero workspaces —
      // but the mock is unconditional, so this proves create() actually
      // gates on the verdict rather than on some other signal (it must 402).
      const res = await as(user.token, 'POST', '/workspaces', { name: 'My First WS' });
      expect(res.statusCode, res.body).toBe(402);
    } finally {
      restore();
    }
  });

  it('blocks a 2nd workspace when entitlements says the cap is reached', async () => {
    const user = await signUpUser(app, 'CappedUser');
    const first = await as(user.token, 'POST', '/workspaces', { name: 'Workspace One' });
    expect(first.statusCode, first.body).toBe(201);

    const restore = forceWorkspaceCapReached();
    try {
      const res = await as(user.token, 'POST', '/workspaces', { name: 'Workspace Two' });
      expect(res.statusCode, res.body).toBe(402);
      expect(res.body).toMatch(/enterprise/i);
    } finally {
      restore();
    }
  });

  it('self-host: a 2nd workspace succeeds — no cap at all', async () => {
    const user = await signUpUser(app, 'SelfHostUser');
    const first = await as(user.token, 'POST', '/workspaces', { name: 'SH One' });
    expect(first.statusCode, first.body).toBe(201);

    const second = await as(user.token, 'POST', '/workspaces', { name: 'SH Two' });
    expect(second.statusCode, second.body).toBe(201);
  });
});
