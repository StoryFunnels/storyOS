// MUST be first: turns MCP_OAUTH on before AppModule is imported (env() caches it).
import { restoreMcpOAuth } from './helpers/enable-mcp-oauth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { connectMcpClient } from './helpers/mcp-oauth-flow';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { user, workspaces } from '../src/db/schema';
import { oauthAccessToken } from '../src/db/auth-schema';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { WorkspaceActivationEventsService } from '../src/workspaces/workspace-activation-events.service';

/**
 * #817 follow-up (product-owner ruling 2026-10-21) — `workspace_activated` counts a hosted-MCP OAuth connection as "an AI client
 * connected", not only a personal access token. Hosted OAuth is how most people connect an AI, and it writes no api_tokens row, so a
 * PAT-only signal undercounted activation. PostHog is faked at the client boundary, as in analytics-funnel-events.test.ts.
 */
let app: NestFastifyApplication;
let db: Db;
let analytics: AnalyticsService;
let sweeper: WorkspaceActivationEventsService;
type Sent = { distinctId: string; event: string; properties: Record<string, unknown> };
const sent: Sent[] = [];
const eventsFor = (wsId: string) => sent.filter((s) => s.event === 'workspace_activated' && s.properties.workspace_id === wsId);

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  analytics = app.get(AnalyticsService);
  sweeper = app.get(WorkspaceActivationEventsService);
  vi.spyOn(analytics, 'config').mockReturnValue({ token: 'phc_test', host: 'https://ph.example' });
  analytics.clientFactory = (() => ({ captureImmediate: async (m: Sent) => { sent.push(m); }, shutdown: async () => undefined })) as unknown as AnalyticsService['clientFactory'];
}, 120_000);
afterAll(async () => { vi.restoreAllMocks(); await app.close(); restoreMcpOAuth(); });

async function workspaceWithRecord(label: string) {
  const u = await signUpUser(app, label);
  const userId = (await db.query.user.findFirst({ where: eq(user.email, u.email) }))!.id;
  const wsId = (await call(app, u.token, 'POST', '/workspaces', { name: label })).json().id as string;
  const space = (await call(app, u.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const dbId = (await call(app, u.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  expect((await call(app, u.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'first' } })).statusCode).toBe(201);
  return { token: u.token, userId, wsId };
}
const activatedAt = async (wsId: string) => (await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) }))!.activatedAt;

describe('#817 a hosted-MCP OAuth connection counts as an AI client connected', () => {
  it('a record plus an OAuth connection (no invite, no personal token) activates once, and the event says it was via OAuth', async () => {
    const w = await workspaceWithRecord('OAuth Only');
    expect(await sweeper.activateIfReady(w.wsId), 'a record alone is not activation').toBe(false);
    await connectMcpClient(app, w.token);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(true);
    const [event] = eventsFor(w.wsId);
    expect(eventsFor(w.wsId)).toHaveLength(1);
    expect(event!.distinctId).toBe(w.userId);
    expect(event!.properties).toMatchObject({ teammate_invited: false, ai_connected: true, ai_connected_via_oauth: true });
    expect(await activatedAt(w.wsId)).not.toBeNull();
    expect(await sweeper.activateIfReady(w.wsId), 'exactly once: a second pass sends nothing').toBe(false);
    expect(eventsFor(w.wsId)).toHaveLength(1);
  });

  it('a personal access token still counts, and the event says it was NOT via OAuth', async () => {
    const w = await workspaceWithRecord('PAT Only');
    const minted = await call(app, w.token, 'POST', '/me/tokens', { name: 'cli', workspace_id: w.wsId, scope: 'admin' });
    expect(minted.statusCode, minted.body).toBe(201);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(true);
    expect(eventsFor(w.wsId)[0]!.properties).toMatchObject({ ai_connected: true, ai_connected_via_oauth: false });
  });

  it('an EXPIRED OAuth connection does not activate (a connection that can no longer be used is not a connected AI)', async () => {
    const w = await workspaceWithRecord('OAuth Expired');
    await connectMcpClient(app, w.token);
    const past = new Date(Date.now() - 60_000);
    await db.update(oauthAccessToken).set({ accessTokenExpiresAt: past, refreshTokenExpiresAt: past }).where(eq(oauthAccessToken.userId, w.userId));
    expect(await sweeper.activateIfReady(w.wsId)).toBe(false);
    expect(eventsFor(w.wsId)).toHaveLength(0);
    expect(await activatedAt(w.wsId)).toBeNull();
  });

  it('a TEAMMATE connecting an AI counts for the workspace (the connection is per person, the activation is per workspace)', async () => {
    const w = await workspaceWithRecord('OAuth Teammate');
    const mate = await joinAs(app, w.token, w.wsId, 'OAuth Mate', 'member');
    await connectMcpClient(app, mate.token);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(true);
    expect(eventsFor(w.wsId)[0]!.properties).toMatchObject({ teammate_invited: true, ai_connected_via_oauth: true });
  });

  it('the Getting Started checklist reads the SAME definition: ai_connected is true for an OAuth-only workspace', async () => {
    const w = await workspaceWithRecord('Checklist');
    await connectMcpClient(app, w.token);
    const state = (await call(app, w.token, 'GET', `/workspaces/${w.wsId}/onboarding`)).json();
    expect(state).toMatchObject({ ai_connected: true, mcp_oauth_connected: true });
  });
});
