import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { inferStateCategory } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, memberships, myWorkDigestSends, spaces, userPreferences, workspaces } from '../db/schema';
import { user } from '../db/auth-schema';
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';
import { MyWorkService } from '../search/my-work.service';
import { mergePreferences, type MyWorkEmailPrefs } from '../users/preferences.constants';
import { digestSlot, digestSourceKey } from './digest-schedule';
import { DIGEST_ROWS_PER_SECTION, renderDigest, type ChipTone, type DigestRow, type DigestSection } from './digest-render';
import { signUnsubscribeToken } from './digest-token';

/** Same name test My work uses to find a database's due-date field. */
const DUE_NAME = /(^|\W)(due|deadline)(\W|$)|due.?date|target.?date/i;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Section = Awaited<ReturnType<MyWorkService['recordSection']>>;
type Membership = typeof memberships.$inferSelect;

/**
 * Ticket #1251 — "Email me my work": the sweep that sends the digest at each person's own local time.
 *
 * What makes it send exactly once per period, across restarts and across API instances: a slot (an instant computed from the person's
 * preference by the schedule trigger's own cadence arithmetic) is CLAIMED by inserting a `my_work_digest_sends` row whose `source_key`
 * (person + workspace + slot) is unique. Only the sweep whose insert wins goes on to build and send; every other sweep, in this process
 * or another, gets no row back. The claim comes BEFORE the send, so a crash between the two loses one digest rather than ever sending
 * two. That is the trade the ticket asks for ("at most once per period").
 *
 * The data is `MyWorkService` — the same three calls the My work page and the MCP make (#1250), so the email cannot disagree with the page
 * about what is open, and every count is an exact SQL count. It is computed for the RECIPIENT's membership, so a row the person cannot
 * open is not in the email, and nothing from anyone's personal space is reachable (MyWorkService excludes it).
 */
@Injectable()
export class MyWorkDigestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MyWorkDigestService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly email: EmailService,
    private readonly myWork: MyWorkService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') this.timer = setInterval(() => void this.sweep(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass at `now`. Public so tests drive it with a fake clock. Returns how many digests it sent. */
  async sweep(now: Date = new Date(), only?: { userIds: string[] }): Promise<number> {
    const rows = await this.db
      .select({ userId: userPreferences.userId, preferences: userPreferences.preferences })
      .from(userPreferences)
      .where(
        and(
          sql`${userPreferences.preferences} -> 'myWorkEmail' ->> 'frequency' IN ('daily', 'weekly')`,
          ...(only ? [inArray(userPreferences.userId, only.userIds)] : []),
        ),
      );
    let sent = 0;
    for (const row of rows) {
      const prefs = mergePreferences(row.preferences).myWorkEmail;
      const slot = digestSlot(prefs, now);
      if (!slot) continue;
      try {
        sent += await this.sendFor(row.userId, prefs, slot);
      } catch (error) {
        // One person's failure must never stop the sweep.
        this.logger.warn(`my work digest failed for ${row.userId}: ${String(error)}`);
      }
    }
    return sent;
  }

  private async sendFor(userId: string, prefs: MyWorkEmailPrefs, slot: Date): Promise<number> {
    const person = await this.db.query.user.findFirst({ where: eq(user.id, userId), columns: { id: true, email: true } });
    if (!person?.email) return 0;
    const mine = await this.db.query.memberships.findMany({
      where: and(eq(memberships.userId, userId), eq(memberships.status, 'active')),
    });
    let sent = 0;
    for (const membership of mine) {
      // The claim: the unique source_key admits exactly one winner for this person, workspace and slot.
      const [claimed] = await this.db
        .insert(myWorkDigestSends)
        .values({ sourceKey: digestSourceKey(userId, membership.workspaceId, slot), userId, workspaceId: membership.workspaceId, slot })
        .onConflictDoNothing({ target: myWorkDigestSends.sourceKey })
        .returning({ id: myWorkDigestSends.id });
      if (!claimed) continue;
      const rendered = await this.build(membership, person.email, prefs, slot);
      if (!rendered) {
        await this.db.update(myWorkDigestSends).set({ outcome: 'empty' }).where(eq(myWorkDigestSends.id, claimed.id));
        continue;
      }
      await this.email.send(
        { kind: 'my-work-digest', to: person.email, subject: rendered.subject, html: rendered.html, text: rendered.text, unsubscribeUrl: rendered.unsubscribeUrl },
        membership.workspaceId,
      );
      await this.db.update(myWorkDigestSends).set({ outcome: 'sent' }).where(eq(myWorkDigestSends.id, claimed.id));
      sent += 1;
    }
    return sent;
  }

  /** The rendered digest for one person in one workspace, or null when every section is empty. */
  async build(membership: Membership, recipientEmail: string, prefs: MyWorkEmailPrefs, slot: Date) {
    const workspace = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, membership.workspaceId), columns: { id: true, name: true } });
    if (!workspace) return null;
    const userId = membership.userId;
    const web = env().WEB_URL.replace(/\/$/, '');
    const base = `${web}/w/${workspace.id}`;

    const [waiting, assigned, byMe] = await Promise.all([
      this.myWork.waiting(membership, userId),
      this.myWork.recordSection(membership, userId, 'assigned'),
      prefs.include_assigned_by_me ? this.myWork.recordSection(membership, userId, 'assigned_by_me') : Promise.resolve(null),
    ]);
    const timezone = prefs.timezone ?? 'UTC';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(slot);

    const waitingRows: DigestRow[] = [
      ...waiting.approvals.items.map((a) => ({
        title: a.preview_text,
        url: `${base}/inbox`,
        meta: ['Approval', a.record?.database_name, a.record?.number != null ? `#${a.record.number}` : null].filter(Boolean).join(' · '),
        chip: { label: 'Approval', tone: 'neutral' as ChipTone },
      })),
      ...waiting.mentions.items.map((m) => ({
        title: `${m.mentioned_by.name}: “${m.excerpt}”`,
        url: `${base}/d/${m.record.database_id}/r/${m.record.id}`,
        meta: ['Mention, not answered', m.record.database_name, m.record.number != null ? `#${m.record.number}` : null].filter(Boolean).join(' · '),
        chip: { label: 'Mention', tone: 'neutral' as ChipTone },
      })),
    ];

    const sections: DigestSection[] = [
      { key: 'waiting', total: waiting.total, rows: waitingRows.slice(0, DIGEST_ROWS_PER_SECTION) },
      { key: 'assigned', total: assigned.total, rows: await this.rows(assigned, base, today, false) },
      { key: 'assigned_by_me', total: byMe?.total ?? 0, rows: byMe ? await this.rows(byMe, base, today, true) : [] },
    ];

    const stopUrl = `${env().API_URL.replace(/\/$/, '')}/api/v1/public/my-work-digest/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(userId))}&ws=${workspace.id}`;
    const rendered = renderDigest({
      workspaceName: workspace.name,
      dateLabel: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(slot),
      sections,
      recipientEmail,
      cadenceText: cadenceText(prefs),
      webUrl: web,
      myWorkUrl: `${base}/me`,
      customizeUrl: `${base}/settings/notifications`,
      stopUrl,
    });
    return rendered ? { ...rendered, unsubscribeUrl: stopUrl } : null;
  }

  /** Flatten a section's per-database groups into one list in My work's order (overdue, due this week, In Progress, the rest; newest change first). */
  private async rows(section: Section, base: string, today: string, showAssignee: boolean): Promise<DigestRow[]> {
    const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    const dbIds = section.groups.map((g) => g.database.id);
    const dbRows = dbIds.length
      ? await this.db
          .select({ id: databases.id, spaceName: spaces.name })
          .from(databases)
          .leftJoin(spaces, eq(spaces.id, databases.spaceId))
          .where(inArray(databases.id, dbIds))
      : [];
    const spaceOf = new Map(dbRows.map((d) => [d.id, d.spaceName]));

    const assigneeIds = new Set<string>();
    if (showAssignee) {
      for (const g of section.groups) {
        const userFields = g.fields.filter((f) => f.type === 'user');
        for (const r of g.records) for (const f of userFields) for (const id of [r.values[f.api_name]].flat()) if (typeof id === 'string') assigneeIds.add(id);
      }
    }
    const names = new Map(
      (assigneeIds.size ? await this.db.query.user.findMany({ where: inArray(user.id, [...assigneeIds]), columns: { id: true, name: true } }) : []).map((u) => [u.id, u.name]),
    );

    const flat: Array<{ rank: number; updated: number; row: DigestRow }> = [];
    for (const g of section.groups) {
      const stateField = g.fields.find((f) => f.type === 'workflow') ?? g.fields.find((f) => f.type === 'select' && /^(state|status)$/i.test(f.display_name.trim()));
      const dueField = g.fields.find((f) => f.type === 'date' && DUE_NAME.test(f.display_name));
      const userFields = g.fields.filter((f) => f.type === 'user');
      for (const r of g.records) {
        const due = dueField && typeof r.values[dueField.api_name] === 'string' ? (r.values[dueField.api_name] as string).slice(0, 10) : null;
        const option = stateField?.options?.find((o) => o.id === r.values[stateField.api_name]);
        const category = option ? (option.category ?? inferStateCategory(option.label)) : null;
        const rank = due && due < today ? 0 : due && due <= weekEnd ? 1 : category === 'started' ? 2 : 3;
        const who = showAssignee
          ? userFields.flatMap((f) => [r.values[f.api_name]].flat()).filter((id): id is string => typeof id === 'string' && names.has(id)).map((id) => names.get(id)!)[0]
          : undefined;
        const tone: ChipTone = category === 'started' ? 'progress' : category === 'blocked' ? 'attention' : 'neutral';
        flat.push({
          rank,
          updated: new Date(r.updated_at).getTime(),
          row: {
            title: r.title,
            url: `${base}/d/${g.database.id}/r/${r.id}`,
            meta: [who, g.database.name, spaceOf.get(g.database.id), r.number != null ? `#${r.number}` : null, due ? `Due ${due}` : null].filter(Boolean).join(' · '),
            ...(option ? { chip: { label: option.label, tone } } : {}),
          },
        });
      }
    }
    flat.sort((a, b) => a.rank - b.rank || b.updated - a.updated);
    return flat.slice(0, DIGEST_ROWS_PER_SECTION).map((f) => f.row);
  }
}

function cadenceText(prefs: MyWorkEmailPrefs): string {
  return prefs.frequency === 'weekly'
    ? `every ${WEEKDAYS[prefs.weekday] ?? 'Monday'} at ${prefs.time}`
    : `every weekday (Mon–Fri) at ${prefs.time}`;
}
