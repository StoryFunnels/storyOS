import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, truncateAll } from './helpers/db';
import { databases, invites, memberships, spaces, user, views, workspaces } from '../src/db/schema';
import { OnboardingNudgeService } from '../src/workspaces/onboarding-nudge.service';
import type { EmailService } from '../src/mail/email.service';

const { db, pool } = connectTestDb();

const DAY_MS = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 5 * DAY_MS); // past the 3-day window
const FRESH = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour old — inside the window

async function makeWorkspace(name: string, createdAt: Date) {
  // truncateAll only cascades from `workspaces`, and `user` (better-auth's own
  // table) has no FK back to it, so a slug-derived email would collide with a
  // leftover row from a prior run of this file — a random suffix sidesteps that
  // entirely instead of depending on cleanup ordering.
  const unique = randomUUID();
  const [ws] = await db
    .insert(workspaces)
    .values({ name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${unique}`, createdAt })
    .returning();
  const [space] = await db.insert(spaces).values({ workspaceId: ws!.id, name: 'General', slug: 'general' }).returning();
  const adminId = `${ws!.id}-admin`;
  const adminEmail = `admin-${unique}@test.storyos.dev`;
  await db.insert(user).values({ id: adminId, name: 'Admin', email: adminEmail });
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: adminId, role: 'admin', status: 'active' });
  return { wsId: ws!.id, spaceId: space!.id, adminEmail };
}

async function addDatabase(workspaceId: string, spaceId: string, name: string) {
  const [row] = await db
    .insert(databases)
    .values({ workspaceId, spaceId, name, apiSlug: name.toLowerCase() })
    .returning();
  return row!.id;
}

async function addGuestInvite(workspaceId: string, accepted: boolean) {
  await db.insert(invites).values({
    workspaceId,
    email: 'guest@test.storyos.dev',
    role: 'guest',
    tokenHash: `tok-${workspaceId}-${Math.random()}`,
    expiresAt: new Date(Date.now() + DAY_MS),
    acceptedAt: accepted ? new Date() : null,
  });
  if (accepted) {
    await db.insert(memberships).values({ workspaceId, userId: `${workspaceId}-guest`, role: 'guest', status: 'active' });
  }
}

/** Attaches a published-form view to `databaseId`, or creates a fresh
 * database for it when none is given — callers that need to control the
 * workspace's total database count (e.g. the second-database tests) pass
 * an existing id so this doesn't silently add a second database. */
async function addPublishedForm(workspaceId: string, spaceId: string, databaseId?: string) {
  const dbId = databaseId ?? (await addDatabase(workspaceId, spaceId, 'Intake'));
  await db.insert(views).values({
    databaseId: dbId,
    name: 'Public form',
    type: 'form',
    config: { form: { public_token: 'tok-abc' } },
  });
}

function emailStub() {
  return { send: vi.fn().mockResolvedValue(undefined) } as unknown as EmailService;
}

afterAll(async () => {
  await pool.end();
});

describe('#650 AC1 — OnboardingNudgeService', () => {
  it('skips a workspace still inside the activation window, for every milestone', async () => {
    await truncateAll(pool);
    const { wsId } = await makeWorkspace('Fresh WS', FRESH);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();

    expect(email.send).not.toHaveBeenCalled();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
    expect(row!.onboardingNudgeGuestInvitedSentAt).toBeNull();
    expect(row!.onboardingNudgeSecondDatabaseSentAt).toBeNull();
    expect(row!.onboardingNudgeFormPublishedSentAt).toBeNull();
  });

  it('sends the guest-invited nudge when a workspace has everything else but no guest', async () => {
    await truncateAll(pool);
    const { wsId, spaceId, adminEmail } = await makeWorkspace('Guest Missing WS', OLD);
    await addDatabase(wsId, spaceId, 'One');
    await addDatabase(wsId, spaceId, 'Two');
    await addPublishedForm(wsId, spaceId);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();

    const calls = (email.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ kind: 'onboarding-nudge', to: adminEmail, milestone: 'guest_invited' });
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
    expect(row!.onboardingNudgeGuestInvitedSentAt).not.toBeNull();
  });

  it('a PENDING (not yet accepted) guest invite already counts as the milestone reached', async () => {
    await truncateAll(pool);
    const { wsId, spaceId } = await makeWorkspace('Pending Guest WS', OLD);
    await addDatabase(wsId, spaceId, 'One');
    await addDatabase(wsId, spaceId, 'Two');
    await addPublishedForm(wsId, spaceId);
    await addGuestInvite(wsId, false);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();

    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends the second-database nudge when only one non-system database exists', async () => {
    await truncateAll(pool);
    const { wsId, spaceId, adminEmail } = await makeWorkspace('Second DB Missing WS', OLD);
    const onlyDbId = await addDatabase(wsId, spaceId, 'Only One');
    await addGuestInvite(wsId, true);
    await addPublishedForm(wsId, spaceId, onlyDbId);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();

    const calls = (email.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ kind: 'onboarding-nudge', to: adminEmail, milestone: 'second_database' });
  });

  it('sends the form-published nudge when no view has a public form token', async () => {
    await truncateAll(pool);
    const { wsId, spaceId, adminEmail } = await makeWorkspace('Form Missing WS', OLD);
    await addDatabase(wsId, spaceId, 'One');
    await addDatabase(wsId, spaceId, 'Two');
    await addGuestInvite(wsId, true);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();

    const calls = (email.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ kind: 'onboarding-nudge', to: adminEmail, milestone: 'form_published' });
  });

  it('sends nothing once all three milestones are reached', async () => {
    await truncateAll(pool);
    const { wsId, spaceId } = await makeWorkspace('All Reached WS', OLD);
    await addDatabase(wsId, spaceId, 'One');
    await addDatabase(wsId, spaceId, 'Two');
    await addGuestInvite(wsId, true);
    await addPublishedForm(wsId, spaceId);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();

    expect(email.send).not.toHaveBeenCalled();
  });

  it('is idempotent: a second sweep never re-sends an already-claimed nudge', async () => {
    await truncateAll(pool);
    const { wsId, spaceId } = await makeWorkspace('Idempotent WS', OLD);
    await addDatabase(wsId, spaceId, 'One');
    await addDatabase(wsId, spaceId, 'Two');
    await addPublishedForm(wsId, spaceId);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();
    expect(email.send).toHaveBeenCalledTimes(1);

    await service.sweep();
    expect(email.send).toHaveBeenCalledTimes(1); // still 1 — no second send
  });

  it('never sends to a workspace with no active admin', async () => {
    await truncateAll(pool);
    const [ws] = await db.insert(workspaces).values({ name: 'No Admin WS', slug: 'no-admin-ws', createdAt: OLD }).returning();
    const [space] = await db.insert(spaces).values({ workspaceId: ws!.id, name: 'General', slug: 'general' }).returning();
    await addDatabase(ws!.id, space!.id, 'One');
    await addDatabase(ws!.id, space!.id, 'Two');
    await addPublishedForm(ws!.id, space!.id);
    const email = emailStub();
    const service = new OnboardingNudgeService(db, email);

    await service.sweep();

    expect(email.send).not.toHaveBeenCalled();
    // But the claim still happened — no admin today doesn't mean retry forever.
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws!.id));
    expect(row!.onboardingNudgeGuestInvitedSentAt).not.toBeNull();
  });
});
