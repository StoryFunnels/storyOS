import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { platformAdmins, user } from '../db/schema';

/**
 * MN-104 — the platform_admin flag. A row in platform_admins, not a column
 * on `user` (better-auth owns that table). Presence = admin.
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const row = await this.db.query.platformAdmins.findFirst({
      where: eq(platformAdmins.userId, userId),
    });
    return !!row;
  }

  /**
   * Boot-time seed from PLATFORM_ADMIN_EMAIL. If no user with that email
   * exists yet (they haven't signed up), logs and no-ops — safe to set the
   * env var before the operator's first sign-up; it takes effect on the next
   * restart after they do.
   */
  async seedFromEnv(email: string): Promise<void> {
    const account = await this.db.query.user.findFirst({ where: eq(user.email, email) });
    if (!account) {
      this.logger.warn(
        `PLATFORM_ADMIN_EMAIL=${email} is set but no matching user exists yet — will retry next boot.`,
      );
      return;
    }
    await this.db
      .insert(platformAdmins)
      .values({ userId: account.id, grantedBy: null })
      .onConflictDoNothing();
    this.logger.log(`Platform admin: ${email} (seeded from PLATFORM_ADMIN_EMAIL).`);
  }

  async grant(userId: string, grantedBy: string): Promise<void> {
    await this.db.insert(platformAdmins).values({ userId, grantedBy }).onConflictDoNothing();
  }

  async revoke(userId: string): Promise<void> {
    await this.db.delete(platformAdmins).where(eq(platformAdmins.userId, userId));
  }
}
