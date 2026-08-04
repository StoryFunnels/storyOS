import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { AccessService } from '../access/access.service';
import type { BillingService } from '../billing/billing.service';
import type { EntitlementsService } from '../billing/entitlements.service';
import type { EmailService } from '../mail/email.service';
import type { MembershipEventsService } from '../events/membership-events.service';
import { InvitesService, INVITE_TTL_MS } from './invites.service';

/** InvitesService.create() never emits (only accept() does), but the constructor
 *  requires the membership-event bus — a no-op stub satisfies both call sites. */
const membershipEvents = { emit: () => undefined } as unknown as MembershipEventsService;

/** A db stub covering exactly the calls InvitesService.create() makes: the
 * "is there already a pending invite for this address" lookup, then either an
 * insert or update, both `.returning()`-ing the created/updated row. */
function makeDb(existingInvite?: { id: string; email: string; role: string }) {
  const db = {
    query: {
      invites: { findFirst: vi.fn().mockResolvedValue(existingInvite) },
      workspaces: { findFirst: vi.fn().mockResolvedValue({ id: 'ws1', name: 'Acme Co' }) },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => [{ id: 'inv1', email: v.email, role: v.role }],
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => [{ id: existingInvite?.id, email: existingInvite?.email, role: v.role ?? existingInvite?.role }],
        }),
      }),
    }),
  } as unknown as Db;
  return db;
}

describe('InvitesService.create — the invite email send point (MN-103)', () => {
  it('sends an invite email whose accept link matches the returned accept_url', async () => {
    const emailService = { send: vi.fn().mockResolvedValue(undefined) } as unknown as EmailService;
    const entitlements = { can: vi.fn().mockResolvedValue(true) } as unknown as EntitlementsService;
    const service = new InvitesService(
      makeDb(),
      {} as unknown as AccessService,
      {} as unknown as BillingService,
      entitlements,
      emailService,
      membershipEvents,
    );

    const result = await service.create('ws1', 'admin1', { email: 'New@Example.com', role: 'member' });

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const sent = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent).toEqual({
      kind: 'invite',
      to: 'new@example.com',
      role: 'member',
      acceptUrl: result.accept_url,
      workspaceName: 'Acme Co',
    });
    expect(result.accept_url).toMatch(/\/invite\?token=/);
  });

  it('rejects a resend within the 60s cooldown without sending an email', async () => {
    const emailService = { send: vi.fn().mockResolvedValue(undefined) } as unknown as EmailService;
    // expiresAt = now + TTL means "sent just now" -> lastSentAt is ~now, inside cooldown.
    const justSent = { id: 'inv1', email: 'p@x.com', role: 'member', expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
    const db = {
      query: { invites: { findFirst: vi.fn().mockResolvedValue(justSent) } },
    } as unknown as Db;
    const service = new InvitesService(
      db,
      {} as unknown as AccessService,
      {} as unknown as BillingService,
      { can: vi.fn() } as unknown as EntitlementsService,
      emailService,
      membershipEvents,
    );

    await expect(service.resend('ws1', 'inv1')).rejects.toMatchObject({ status: 429 });
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('resends with a fresh link once the cooldown has elapsed', async () => {
    const emailService = { send: vi.fn().mockResolvedValue(undefined) } as unknown as EmailService;
    // Sent 2 minutes ago (expiresAt = now + TTL - 2min) -> outside the 60s cooldown.
    const stale = {
      id: 'inv1',
      email: 'p@x.com',
      role: 'member',
      expiresAt: new Date(Date.now() + INVITE_TTL_MS - 2 * 60 * 1000),
    };
    const db = {
      query: {
        invites: { findFirst: vi.fn().mockResolvedValue(stale) },
        workspaces: { findFirst: vi.fn().mockResolvedValue({ id: 'ws1', name: 'Acme Co' }) },
      },
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [stale] }) }),
      }),
    } as unknown as Db;
    const service = new InvitesService(
      db,
      {} as unknown as AccessService,
      {} as unknown as BillingService,
      { can: vi.fn() } as unknown as EntitlementsService,
      emailService,
      membershipEvents,
    );

    const result = await service.resend('ws1', 'inv1');
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(result.accept_url).toMatch(/\/invite\?token=/);
  });

  it('blocks a billable invite over the Free seat cap before ever sending an email', async () => {
    const emailService = { send: vi.fn() } as unknown as EmailService;
    const entitlements = { can: vi.fn().mockResolvedValue(false) } as unknown as EntitlementsService;
    const service = new InvitesService(
      makeDb(),
      {} as unknown as AccessService,
      {} as unknown as BillingService,
      entitlements,
      emailService,
      membershipEvents,
    );

    await expect(
      service.create('ws1', 'admin1', { email: 'x@y.com', role: 'member' }),
    ).rejects.toThrow(/Free plan/);
    expect(emailService.send).not.toHaveBeenCalled();
  });
});
