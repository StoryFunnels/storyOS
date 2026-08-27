import { Global, Module } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { EmailService } from '../mail/email.service';
import { MembershipEventsService } from '../events/membership-events.service';
import { memberships } from '../db/schema';
import { createAuth } from './auth';
import { AuthGuard } from './auth.guard';
import { AUTH } from './auth.tokens';

export { AUTH } from './auth.tokens';

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      useFactory: (db: Db, emailService: EmailService, membershipEvents: MembershipEventsService) =>
        createAuth(db, emailService, (userId) => {
          /*
           * #419 — fan the profile change out to every workspace this person is
           * in. A profile is global; its projection is per workspace, so one
           * edit has to reach all of them or the same name is right in one
           * place and wrong in another.
           *
           * Fire-and-forget with a swallowed rejection, matching every other
           * membership emit: this runs inside better-auth's update flow, and a
           * failed refresh must never fail the rename that caused it.
           */
          void db.query.memberships
            .findMany({ where: eq(memberships.userId, userId), columns: { workspaceId: true } })
            .then((rows) => {
              for (const r of rows) {
                membershipEvents.emit({ type: 'membership_changed', workspaceId: r.workspaceId, userId });
              }
            })
            .catch(() => undefined);
        }),
      inject: [DB, EmailService, MembershipEventsService],
    },
    AuthGuard,
  ],
  exports: [AUTH, AuthGuard],
})
export class AuthModule {}
