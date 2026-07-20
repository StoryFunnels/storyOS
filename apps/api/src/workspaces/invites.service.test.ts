import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { AccessService } from '../access/access.service';
import type { BillingService } from '../billing/billing.service';
import type { EntitlementsService } from '../billing/entitlements.service';
import type { EmailService } from '../mail/email.service';
import { InvitesService } from './invites.service';

/** A db stub covering exactly the calls InvitesService.create() makes: the
 * "is there already a pending invite for this address" lookup, then either an
 * insert or update, both `.returning()`-ing the created/updated row. */
function makeDb(existingInvite?: { id: string; email: string; role: string }) {
  const db = {
    query: { invites: { findFirst: vi.fn().mockResolvedValue(existingInvite) } },
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
    );

    const result = await service.create('ws1', 'admin1', { email: 'New@Example.com', role: 'member' });

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const sent = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent).toEqual({
      kind: 'invite',
      to: 'new@example.com',
      role: 'member',
      acceptUrl: result.accept_url,
    });
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
    );

    await expect(
      service.create('ws1', 'admin1', { email: 'x@y.com', role: 'member' }),
    ).rejects.toThrow(/Free plan/);
    expect(emailService.send).not.toHaveBeenCalled();
  });
});
