import { expect } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authed } from './users';

/**
 * #1030 — authorize no longer hands out a code: it sends the person to the consent page. This is the person pressing Allow,
 * for tests that need a working OAuth token and are not about consent itself. Takes the authorize call's Location, returns the
 * Location a client would then be sent to (with its code), exactly as the real flow does. #1079: with no `workspaceId` the grant is
 * the default, ALL the person's workspaces; pass one to limit it to that workspace.
 */
export async function approveAuthorize(
  app: NestFastifyApplication,
  sessionToken: string,
  authorizeLocation: string,
  opts: { workspaceId?: string } = {},
): Promise<string> {
  const consentCode = new URL(authorizeLocation).searchParams.get('consent_code');
  expect(consentCode, `authorize must redirect to the consent page, got ${authorizeLocation}`).toBeTruthy();
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(sessionToken), payload: payload as never });
  const workspaceId = opts.workspaceId;
  // Tests that connect a client expect the person to have somewhere to act: create a workspace if they have none.
  if (!workspaceId && ((await call('GET', '/workspaces')).json() as unknown[]).length === 0) await call('POST', '/workspaces', { name: 'OAuth consent WS' });
  const decided = await call('POST', '/oauth/consent', { consent_code: consentCode, decision: 'allow', ...(workspaceId ? { workspace_id: workspaceId } : {}) });
  expect(decided.statusCode, decided.body).toBe(201);
  return decided.json().redirect_url as string;
}
