import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client';
import { invites } from '../db/schema';

/** The one-way hash an invite token is stored under (ticket #1302). Shared so no second caller can hash it differently. */
export const hashInviteToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Ticket #1347 — does `token` name a PENDING invite issued to exactly `email`?
 *
 * Used at sign-up to decide whether the new account was created through the invite link: the link was mailed to that address, so
 * holding it while registering that address is the same proof of the mailbox as a magic link. Pending means what accept() means by
 * it: not used, not revoked, not expired.
 *
 * It answers only yes or no and never throws for a bad token: a token that names nothing, a spent one, and one issued to another
 * address all return false, so the sign-up that follows is an ordinary one and its response says nothing about the invite. A
 * malformed token is hashed as the empty string (which no real token can equal) rather than returning early, the same shape as
 * `InvitesService.details()`, so "bad shape" is not a faster, distinguishable answer.
 */
export async function inviteTokenVouchesFor(db: Db, token: unknown, email: string): Promise<boolean> {
  const raw = typeof token === 'string' && token.length <= 256 ? token : '';
  const invite = await db.query.invites.findFirst({ where: eq(invites.tokenHash, hashInviteToken(raw)) });
  if (!invite || invite.acceptedAt || invite.revokedAt) return false;
  if (invite.expiresAt.getTime() < Date.now()) return false;
  return invite.email === email.toLowerCase();
}
