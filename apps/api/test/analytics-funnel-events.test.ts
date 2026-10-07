import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { apiTokens, billingCustomers, billingSubscriptions, databases, records, user, workspaces } from '../src/db/schema';
import { AnalyticsService, eventUuid } from '../src/analytics/analytics.service';
import { ActivationService } from '../src/workspaces/activation.service';
import { WorkspaceActivationEventsService } from '../src/workspaces/workspace-activation-events.service';
import { BillingService } from '../src/billing/billing.service';
import { TokensService } from '../src/tokens/tokens.service';

// Hoisted so it runs BEFORE the imports below: env() is cached the first time anything reads it,
// and importing the app module is enough to do that.
vi.hoisted(() => {
  process.env.STRIPE_PRICE_PRO = 'price_pro_test';
  process.env.STRIPE_PRICE_BUSINESS = 'price_business_test';
  process.env.STRIPE_PRICE_SEAT = 'price_seat_test';
});

/**
 * #817 — the two funnel events no client can see, against a real database.
 *
 * PostHog itself is faked at the client boundary (AnalyticsService.clientFactory), so
 * what is asserted is exactly what WOULD be sent. What this file CANNOT prove, and the
 * PR says so: that PostHog accepts the event and joins it to the same person as
 * `user_signed_up` (that needs the real project), and a live Stripe test-mode checkout.
 */
let app: NestFastifyApplication;
let db: Db;
let analytics: AnalyticsService;
let sweeper: WorkspaceActivationEventsService;
let activation: ActivationService;
let billing: BillingService;
let tokens: TokensService;

type Sent = { distinctId: string; event: string; uuid?: string; properties: Record<string, unknown>; disableGeoip?: boolean };
const sent: Sent[] = [];
let failNextSend = false;
const factoryCalls = { n: 0 };

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const eventsFor = (workspaceId: string, event: string) =>
  sent.filter((s) => s.event === event && s.properties.workspace_id === workspaceId);

interface Ws {
  token: string;
  userId: string;
  wsId: string;
  dbId: string;
  spaceId: string;
}
async function newWorkspace(label: string): Promise<Ws> {
  const u = await signUpUser(app, label);
  const userId = (await db.query.user.findFirst({ where: eq(user.email, u.email) }))!.id;
  const wsId = (await as(u.token, 'POST', '/workspaces', { name: label })).json().id;
  const spaceId = (await as(u.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const dbId = (await as(u.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  return { token: u.token, userId, wsId, dbId, spaceId };
}
const addRecord = (w: Ws, token = w.token, name = `r-${randomUUID().slice(0, 6)}`) =>
  as(token, 'POST', `/workspaces/${w.wsId}/databases/${w.dbId}/records`, { values: { name } });
const inviteTeammate = (w: Ws) =>
  as(w.token, 'POST', `/workspaces/${w.wsId}/invites`, { email: `${randomUUID()}@invite.test`, role: 'member' });
const activatedAt = async (wsId: string) => (await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) }))!.activatedAt;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  analytics = app.get(AnalyticsService);
  sweeper = app.get(WorkspaceActivationEventsService);
  activation = app.get(ActivationService);
  billing = app.get(BillingService);
  tokens = app.get(TokensService);
  // Configured, with PostHog replaced by a recorder.
  vi.spyOn(analytics, 'config').mockReturnValue({ token: 'phc_test', host: 'https://ph.example' });
  analytics.clientFactory = (() => {
    factoryCalls.n++;
    return {
      captureImmediate: async (m: Sent) => {
        if (failNextSend) {
          failNextSend = false;
          throw new Error('PostHog unreachable');
        }
        sent.push(m);
      },
      shutdown: async () => undefined,
    };
  }) as unknown as AnalyticsService['clientFactory'];
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
});

describe('#817 workspace_activated — AC1', () => {
  it('a record alone is NOT activation: that is a solo user trying a database tool', async () => {
    const w = await newWorkspace('Solo');
    expect((await addRecord(w)).statusCode).toBe(201);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(false);
    expect(eventsFor(w.wsId, 'workspace_activated')).toHaveLength(0);
    expect(await activatedAt(w.wsId)).toBeNull();
  });

  it('a record plus an invited teammate fires once, on the founder, with the right properties', async () => {
    const w = await newWorkspace('Invites');
    await addRecord(w);
    expect((await inviteTeammate(w)).statusCode).toBeLessThan(300);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(true);

    const [event] = eventsFor(w.wsId, 'workspace_activated');
    expect(eventsFor(w.wsId, 'workspace_activated')).toHaveLength(1);
    expect(event!.distinctId).toBe(w.userId); // AC3: the id the web identify call uses
    expect(event!.uuid).toBe(eventUuid('workspace_activated', w.wsId));
    expect(event!.properties).toMatchObject({ workspace_id: w.wsId, teammate_invited: true, ai_connected: false, workspace_age_days: 0 });
    expect(await activatedAt(w.wsId)).not.toBeNull();
  });

  it('is EXACTLY ONCE: repeated sweeps and a burst of concurrent attempts still send one event', async () => {
    const w = await newWorkspace('Once');
    await addRecord(w);
    await inviteTeammate(w);
    const results = await Promise.all(Array.from({ length: 8 }, () => sweeper.activateIfReady(w.wsId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await sweeper.sweep();
    await sweeper.sweep();
    expect(await sweeper.activateIfReady(w.wsId)).toBe(false);
    expect(eventsFor(w.wsId, 'workspace_activated')).toHaveLength(1);
  });

  it('counts activity that arrives over MCP/the API: records written with a personal access token, no session', async () => {
    const w = await newWorkspace('McpOnly');
    const pat = await tokens.create(w.userId, w.wsId, 'my MCP client', 'write', true);
    // The ONLY record in this workspace is written by the token, never by a session.
    const viaToken = await addRecord(w, pat.token, 'written by an agent');
    expect(viaToken.statusCode, viaToken.body).toBe(201);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(true);
    const [event] = eventsFor(w.wsId, 'workspace_activated');
    expect(event!.properties).toMatchObject({ ai_connected: true, teammate_invited: false });
  });

  it("sample data does not count as a 'real' record", async () => {
    const w = await newWorkspace('Sample');
    const rec = (await addRecord(w)).json();
    await db.update(workspaces).set({ settings: { sample_record_ids: [rec.id] } }).where(eq(workspaces.id, w.wsId));
    await inviteTeammate(w);
    expect(await activation.recordsAdded(w.wsId)).toBe(false);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(false);
  });

  it('a record in a SYSTEM database (provisioned for the user, not by them) does not count', async () => {
    const w = await newWorkspace('System');
    // Every workspace is provisioned with a system `Members` database (#320). Drop the
    // user's own database so that is the only one left, and put a record in it.
    await db.delete(databases).where(eq(databases.id, w.dbId));
    const sys = await db.query.databases.findFirst({ where: and(eq(databases.workspaceId, w.wsId), eq(databases.isSystem, true)) });
    expect(sys, 'the workspace should ship a system database').toBeDefined();
    await db.insert(records).values({ databaseId: sys!.id, values: {}, title: 'provisioned' } as never);
    await inviteTeammate(w);
    expect(await activation.recordsAdded(w.wsId)).toBe(false);
  });

  it("'AI connected' means a real, live client: not Tyron's per-turn token, not a revoked one", async () => {
    const w = await newWorkspace('Tokens');
    const base = { userId: w.userId, workspaceId: w.wsId, tokenPrefix: 'mn_pat_test', scope: 'write' as const };
    // Tyron mints an ordinary token per turn: origin 'agent', no agent_id, revoked when the turn ends.
    await db.insert(apiTokens).values({ ...base, name: 'Tyron (approved)', tokenHash: randomUUID(), origin: 'agent' });
    expect(await activation.aiConnected(w.wsId)).toBe(false);
    // A person's revoked token is no longer a connected client.
    await db.insert(apiTokens).values({ ...base, name: 'old client', tokenHash: randomUUID(), revokedAt: new Date() });
    expect(await activation.aiConnected(w.wsId)).toBe(false);
    // A configured Agent's credential IS a connected client.
    await db.insert(apiTokens).values({ ...base, name: 'agent cred', tokenHash: randomUUID(), origin: 'agent', agentId: randomUUID() });
    expect(await activation.aiConnected(w.wsId)).toBe(true);
  });

  it('the Getting Started checklist reads the same definition (no second copy to drift)', async () => {
    const w = await newWorkspace('Checklist');
    await db.insert(apiTokens).values({ userId: w.userId, workspaceId: w.wsId, name: 'Tyron (approved)', tokenHash: randomUUID(), tokenPrefix: 'mn_pat_test', origin: 'agent' });
    const res = await as(w.token, 'GET', `/workspaces/${w.wsId}/onboarding`);
    expect(res.statusCode).toBe(200);
    expect(res.json().ai_connected).toBe(false);
    expect(Object.keys(res.json()).sort()).toEqual(
      ['ai_connected', 'board_view_built', 'business_pack_installed', 'database_created', 'records_added', 'relation_created', 'teammate_invited'],
    );
  });

  it('a failed send releases the claim, so an outage DELAYS the event instead of losing it', async () => {
    const w = await newWorkspace('Outage');
    await addRecord(w);
    await inviteTeammate(w);
    failNextSend = true;
    expect(await sweeper.activateIfReady(w.wsId)).toBe(false);
    expect(await activatedAt(w.wsId)).toBeNull();
    expect(eventsFor(w.wsId, 'workspace_activated')).toHaveLength(0);
    expect(await sweeper.activateIfReady(w.wsId)).toBe(true);
    expect(eventsFor(w.wsId, 'workspace_activated')).toHaveLength(1);
  });
});

describe('#817 AC4 — unconfigured (every self-hoster) does nothing at all', () => {
  it('no sweep work, no write, no client, no throw — even for a workspace that is activated', async () => {
    const w = await newWorkspace('SelfHost');
    await addRecord(w);
    await inviteTeammate(w);
    const spy = vi.spyOn(analytics, 'config').mockReturnValue(null);
    const callsBefore = factoryCalls.n;
    const before = sent.length;
    try {
      await expect(sweeper.sweep()).resolves.toBe(0);
      await expect(analytics.capture({ distinctId: 'u', event: 'workspace_activated' })).resolves.toBe('disabled');
    } finally {
      spy.mockReturnValue({ token: 'phc_test', host: 'https://ph.example' });
    }
    expect(sent.length).toBe(before);
    expect(factoryCalls.n).toBe(callsBefore);
    expect(await activatedAt(w.wsId)).toBeNull(); // never even claimed
  });
});

/** A minimal Stripe.Subscription with the fields reconcile actually reads. */
function subscription(customer: string, status: Stripe.Subscription.Status, o: { price?: string; seats?: number; trialEnd?: number | null; id?: string } = {}) {
  return {
    id: o.id ?? `sub_${customer}`,
    customer,
    status,
    cancel_at_period_end: false,
    trial_end: o.trialEnd ?? null,
    items: {
      data: [
        { price: { id: o.price ?? 'price_pro_test' }, quantity: 1, current_period_end: 1893456000 },
        { price: { id: 'price_seat_test' }, quantity: o.seats ?? 2 },
      ],
    },
  } as unknown as Stripe.Subscription;
}
async function billedWorkspace(label: string) {
  const w = await newWorkspace(label);
  const customer = `cus_${randomUUID().slice(0, 8)}`;
  await db.insert(billingCustomers).values({ workspaceId: w.wsId, stripeCustomerId: customer });
  return { w, customer };
}
const started = async (wsId: string) => (await db.query.billingSubscriptions.findFirst({ where: eq(billingSubscriptions.workspaceId, wsId) }))?.subscriptionStartedAt ?? null;

describe('#817 subscription_started — AC2', () => {
  it('a trial is NOT paying: trialing fires nothing', async () => {
    const { w, customer } = await billedWorkspace('Trial');
    await billing.reconcileSubscription(subscription(customer, 'trialing', { trialEnd: 1893456000 }));
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(0);
    expect(await started(w.wsId)).toBeNull();
  });

  it('trial converting to paid fires once, with plan and seats, on the founder', async () => {
    const { w, customer } = await billedWorkspace('Convert');
    await billing.reconcileSubscription(subscription(customer, 'trialing', { trialEnd: 1893456000 }));
    await billing.reconcileSubscription(subscription(customer, 'active', { seats: 3 }));
    const events = eventsFor(w.wsId, 'subscription_started');
    expect(events).toHaveLength(1);
    expect(events[0]!.distinctId).toBe(w.userId);
    expect(events[0]!.uuid).toBe(eventUuid('subscription_started', w.wsId));
    expect(events[0]!.properties).toMatchObject({ plan: 'pro', seats: 3, converted_from_trial: true, surface: 'app' });
  });

  it('direct-to-paid fires once too', async () => {
    const { w, customer } = await billedWorkspace('Direct');
    await billing.reconcileSubscription(subscription(customer, 'active'));
    const events = eventsFor(w.wsId, 'subscription_started');
    expect(events).toHaveLength(1);
    expect(events[0]!.properties).toMatchObject({ plan: 'pro', converted_from_trial: false });
  });

  it('a later upgrade, a seat change or a renewal does NOT fire again', async () => {
    const { w, customer } = await billedWorkspace('Upgrade');
    await billing.reconcileSubscription(subscription(customer, 'active'));
    await billing.reconcileSubscription(subscription(customer, 'active', { price: 'price_business_test', seats: 6 }));
    await billing.reconcileSubscription(subscription(customer, 'active', { price: 'price_business_test', seats: 9 }));
    await billing.reconcileSubscription(subscription(customer, 'active', { price: 'price_business_test', seats: 9 })); // renewal / invoice.paid
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(1);
  });

  it('only money counts: past_due fires nothing, and the first ACTIVE does', async () => {
    const { w, customer } = await billedWorkspace('PastDue');
    await billing.reconcileSubscription(subscription(customer, 'past_due'));
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(0);
    await billing.reconcileSubscription(subscription(customer, 'active'));
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(1);
  });

  it('is the FIRST time ever: cancelling and resubscribing is not a second start', async () => {
    const { w, customer } = await billedWorkspace('Resub');
    await billing.reconcileSubscription(subscription(customer, 'active'));
    await billing.reconcileSubscription(subscription(customer, 'canceled'));
    await billing.reconcileSubscription(subscription(customer, 'active', { id: `sub_${randomUUID()}` }));
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(1);
  });

  it('a failed send releases the claim, so the next projection of the subscription retries', async () => {
    const { w, customer } = await billedWorkspace('BillingOutage');
    failNextSend = true;
    await billing.reconcileSubscription(subscription(customer, 'active'));
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(0);
    expect(await started(w.wsId)).toBeNull();
    await billing.reconcileSubscription(subscription(customer, 'active'));
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(1);
  });

  it('unconfigured: the billing state is still projected, and nothing is claimed or sent', async () => {
    const { w, customer } = await billedWorkspace('BillingSelfHost');
    const spy = vi.spyOn(analytics, 'config').mockReturnValue(null);
    try {
      await expect(billing.reconcileSubscription(subscription(customer, 'active'))).resolves.toBeUndefined();
    } finally {
      spy.mockReturnValue({ token: 'phc_test', host: 'https://ph.example' });
    }
    const row = await db.query.billingSubscriptions.findFirst({ where: eq(billingSubscriptions.workspaceId, w.wsId) });
    expect(row?.status).toBe('active'); // the real work still happened
    expect(row?.subscriptionStartedAt).toBeNull();
    expect(eventsFor(w.wsId, 'subscription_started')).toHaveLength(0);
  });
});
