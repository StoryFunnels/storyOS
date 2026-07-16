import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-122: a PAT is minted FOR a workspace and must only work there.
 *
 * The guard used to drop the token's workspaceId, so a token "for workspace A"
 * authenticated against every workspace its owner belonged to — an account-wide
 * credential wearing a scoped label.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let wsA: string;
let wsB: string;
let dbA: string;
let dbB: string;
let patA: string;

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  // ONE user who is an active member of BOTH workspaces — the whole point: the
  // owner's membership is not what should scope the token.
  owner = await signUpUser(app, 'Scoped');
  wsA = (await inject('POST', '/workspaces', { name: 'Workspace A' })).json().id;
  wsB = (await inject('POST', '/workspaces', { name: 'Workspace B' })).json().id;

  const spaceA = (await inject('GET', `/workspaces/${wsA}/spaces`)).json()[0].id;
  const spaceB = (await inject('GET', `/workspaces/${wsB}/spaces`)).json()[0].id;
  dbA = (await inject('POST', `/workspaces/${wsA}/databases`, { space_id: spaceA, name: 'A tasks' })).json().id;
  dbB = (await inject('POST', `/workspaces/${wsB}/databases`, { space_id: spaceB, name: 'B tasks' })).json().id;

  patA = (await inject('POST', '/me/tokens', { name: 'A only', workspace_id: wsA })).json().token;
  expect(patA).toMatch(/^mn_pat_/);
});

afterAll(async () => {
  await app.close();
});

describe('a workspace-A PAT (MN-122)', () => {
  it('works on workspace A', async () => {
    const res = await inject('GET', `/workspaces/${wsA}/databases`, undefined, patA);
    expect(res.statusCode).toBe(200);
  });

  it('is REFUSED on workspace B — even though the owner is a member of B', async () => {
    const res = await inject('GET', `/workspaces/${wsB}/databases`, undefined, patA);
    expect(res.statusCode, 'this is the bug: the owner being a member of B must not matter').toBe(404);
  });

  it('404s rather than 403s, so it cannot probe which workspaces exist', async () => {
    const res = await inject('GET', `/workspaces/${wsB}`, undefined, patA);
    expect(res.statusCode).toBe(404);
  });

  it('cannot reach a nested resource in workspace B either', async () => {
    // The check is in AuthGuard, so it holds regardless of which guards a
    // controller happens to declare.
    for (const url of [
      `/workspaces/${wsB}/databases/${dbB}`,
      `/workspaces/${wsB}/databases/${dbB}/records`,
      `/workspaces/${wsB}/members`,
      `/workspaces/${wsB}/search?q=x`,
    ]) {
      const res = await inject('GET', url, undefined, patA);
      expect([404], `${url} leaked`).toContain(res.statusCode);
    }
  });

  it('still reaches nested resources in its own workspace', async () => {
    const res = await inject('GET', `/workspaces/${wsA}/databases/${dbA}`, undefined, patA);
    expect(res.statusCode).toBe(200);
  });

  it('a session still reaches BOTH workspaces — the fix scopes tokens, not people', async () => {
    expect((await inject('GET', `/workspaces/${wsA}/databases`)).statusCode).toBe(200);
    expect((await inject('GET', `/workspaces/${wsB}/databases`)).statusCode).toBe(200);
  });
});

describe('token management is session-only (MN-122)', () => {
  it('a PAT cannot mint another PAT — otherwise scoping is trivially bypassed', async () => {
    // The escalation path: a leaked A-token asks for a B-token and walks around
    // the scope entirely.
    const res = await inject('POST', '/me/tokens', { name: 'escalate', workspace_id: wsB }, patA);
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.message ?? res.json().message).toMatch(/cannot manage tokens/);
  });

  it('a PAT cannot revoke a token', async () => {
    const list = (await inject('GET', '/me/tokens')).json().data;
    const res = await inject('DELETE', `/me/tokens/${list[0].id}`, undefined, patA);
    expect(res.statusCode).toBe(403);
  });

  it('a session still can', async () => {
    const created = await inject('POST', '/me/tokens', { name: 'from a session', workspace_id: wsB });
    expect(created.statusCode).toBe(201);
    expect((await inject('DELETE', `/me/tokens/${created.json().id}`)).statusCode).toBe(200);
  });

  it('refuses to mint a token for a workspace you are not in', async () => {
    const stranger = await signUpUser(app, 'Stranger');
    const res = await inject('POST', '/me/tokens', { name: 'nope', workspace_id: wsA }, stranger.token);
    expect(res.statusCode).toBe(404);
  });
});
