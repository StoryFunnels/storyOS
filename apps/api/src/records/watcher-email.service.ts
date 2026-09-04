import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { user } from '../db/schema';
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';
import { PreferencesService } from '../users/preferences.service';

/**
 * #273 — a record with many watchers must not turn one change into a mail
 * burst. `record_watchers` has no cap of its own (anyone can watch), so this
 * bounds the EMAIL fan-out specifically — the in-app notification
 * (`NotificationsService`) stays unbounded, it's cheap and already
 * burst-collapses. Deliberately chosen, not discovered from a mail
 * provider's rate limit: the first 50 watchers (by no particular order —
 * "who gets emailed" isn't meant to be meaningful) get mailed; the rest
 * still get the in-app notification, same as everyone always has.
 */
const MAX_WATCHER_EMAILS_PER_CHANGE = 50;

/**
 * Mails a `record_changed` notification to a record's watchers. Split out of
 * `RecordsService` (already large) rather than injecting `EmailService`/
 * `PreferencesService` there directly — mirrors `comments.service.ts`'s
 * `notifyMentions` exactly: same preference-gate shape (skip only on an
 * EXPLICIT `false`, matching `NotificationsService.filterByPreference`'s
 * gate on the in-app leg of the same toggle), same fire-and-forget
 * `EmailService.send` contract, same `${webUrl}/r/{recordId}` deep-link
 * convention as `commentDeepLink`.
 */
@Injectable()
export class WatcherEmailService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly emailService: EmailService,
    private readonly preferences: PreferencesService,
  ) {}

  async notify(
    workspaceId: string,
    recordId: string,
    recordTitle: string,
    actorName: string | null,
    summary: string,
    watcherIds: string[],
  ): Promise<void> {
    if (watcherIds.length === 0) return;
    const capped = watcherIds.slice(0, MAX_WATCHER_EMAILS_PER_CHANGE);

    const [recipients, prefs] = await Promise.all([
      this.db.query.user.findMany({
        where: inArray(user.id, capped),
        columns: { id: true, email: true },
      }),
      this.preferences.notificationPrefsFor(capped),
    ]);

    for (const recipient of recipients) {
      if (prefs.get(recipient.id)?.record_changed === false) continue;
      await this.emailService.send(
        {
          kind: 'record-changed',
          to: recipient.email,
          actorName: actorName ?? 'Someone',
          recordTitle,
          summary,
          url: `${env().WEB_URL}/r/${recordId}`,
        },
        workspaceId,
      );
    }
  }
}
