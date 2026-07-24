import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  calendarEventLinks,
  calendarSyncBindings,
  connections,
  databases,
  fields,
  records,
  spaces,
} from '../db/schema';
import { ConnectionsService } from '../connections/connections.service';
import type { GoogleAuth } from '../connections/providers';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { RecordsService } from '../records/records.service';

const API = 'https://www.googleapis.com/calendar/v3';
const INBOUND_SYNC_DEPTH = 100;
const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface GoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
}

interface GoogleEvent {
  id: string;
  updated?: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export interface CreateCalendarBindingInput {
  connection_id: string;
  database_id: string;
  calendar_id: string;
  calendar_name: string;
  start_field_id: string;
  end_field_id?: string;
  description_field_id?: string;
  direction?: 'push' | 'pull' | 'two_way';
}

type Binding = typeof calendarSyncBindings.$inferSelect;

@Injectable()
export class CalendarSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CalendarSyncService.name);
  private pollTimer?: NodeJS.Timeout;
  fetcher: typeof fetch = fetch;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connectionsService: ConnectionsService,
    private readonly domainEvents: DomainEventsService,
    private readonly recordsService: RecordsService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => {
      if (event.depth === INBOUND_SYNC_DEPTH) return;
      if (
        event.type === 'record_created' ||
        event.type === 'record_updated' ||
        event.type === 'record_deleted'
      ) {
        void this.handleRecordEvent(event).catch((error) => {
          this.logger.warn(
            `calendar sync failed for record ${event.recordId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    });
    if (process.env.NODE_ENV !== 'test') {
      this.pollTimer = setInterval(() => {
        void this.pollInboundBindings().catch((error) => {
          this.logger.warn(
            `calendar polling sweep failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, POLL_INTERVAL_MS);
      this.pollTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async listCalendars(workspaceId: string, connectionId: string) {
    const auth = await this.calendarAuth(workspaceId, connectionId);
    const result = await this.googleJson<{ items?: GoogleCalendar[] }>(
      `${API}/users/me/calendarList?minAccessRole=writer&maxResults=250`,
      auth,
    );
    return {
      data: (result.items ?? []).map((calendar) => ({
        id: calendar.id,
        name: calendar.summary,
        primary: calendar.primary === true,
        access_role: calendar.accessRole ?? null,
      })),
    };
  }

  async listBindings(workspaceId: string) {
    const rows = await this.db
      .select({
        binding: calendarSyncBindings,
        databaseName: databases.name,
        spaceName: spaces.name,
        connectionName: connections.name,
        startFieldName: fields.displayName,
      })
      .from(calendarSyncBindings)
      .innerJoin(databases, eq(databases.id, calendarSyncBindings.databaseId))
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .innerJoin(connections, eq(connections.id, calendarSyncBindings.connectionId))
      .innerJoin(fields, eq(fields.id, calendarSyncBindings.startFieldId))
      .where(eq(calendarSyncBindings.workspaceId, workspaceId));
    return {
      data: rows.map(({ binding, databaseName, spaceName, connectionName, startFieldName }) => ({
        id: binding.id,
        connection_id: binding.connectionId,
        connection_name: connectionName,
        database_id: binding.databaseId,
        database_name: databaseName,
        database_space_name: spaceName,
        calendar_id: binding.calendarId,
        calendar_name: binding.calendarName,
        start_field_id: binding.startFieldId,
        start_field_name: startFieldName,
        end_field_id: binding.endFieldId,
        description_field_id: binding.descriptionFieldId,
        direction: binding.direction,
        status: binding.status,
        last_sync_at: binding.lastSyncAt,
        last_error: binding.lastError,
      })),
    };
  }

  async createBinding(workspaceId: string, userId: string, input: CreateCalendarBindingInput) {
    await this.calendarAuth(workspaceId, input.connection_id);
    const database = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, input.database_id), eq(databases.workspaceId, workspaceId)),
    });
    if (!database) throw new NotFoundException('Database not found');

    const selectedFieldIds = [
      input.start_field_id,
      input.end_field_id,
      input.description_field_id,
    ].filter((id): id is string => Boolean(id));
    const selectedFields = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, database.id), isNull(fields.deletedAt)),
    });
    const byId = new Map(selectedFields.map((field) => [field.id, field]));
    const start = byId.get(input.start_field_id);
    if (!start || start.type !== 'date') {
      throw new BadRequestException('Start field must be a date field on this database');
    }
    if (selectedFieldIds.some((id) => !byId.has(id))) {
      throw new BadRequestException('Every mapped field must belong to the selected database');
    }
    if (input.end_field_id && byId.get(input.end_field_id)?.type !== 'date') {
      throw new BadRequestException('End field must be a date field');
    }
    const description = input.description_field_id
      ? byId.get(input.description_field_id)
      : undefined;
    if (description && description.type !== 'text' && description.type !== 'rich_text') {
      throw new BadRequestException('Description field must be text or rich text');
    }

    const [binding] = await this.db
      .insert(calendarSyncBindings)
      .values({
        workspaceId,
        connectionId: input.connection_id,
        databaseId: input.database_id,
        calendarId: input.calendar_id,
        calendarName: input.calendar_name,
        startFieldId: input.start_field_id,
        endFieldId: input.end_field_id,
        descriptionFieldId: input.description_field_id,
        direction: input.direction ?? 'push',
        createdBy: userId,
      })
      .returning();
    return { id: binding!.id };
  }

  async deleteBinding(workspaceId: string, bindingId: string) {
    const deleted = await this.db
      .delete(calendarSyncBindings)
      .where(
        and(
          eq(calendarSyncBindings.id, bindingId),
          eq(calendarSyncBindings.workspaceId, workspaceId),
        ),
      )
      .returning({ id: calendarSyncBindings.id });
    if (!deleted.length) throw new NotFoundException('Calendar binding not found');
    return { deleted: true };
  }

  async syncBinding(workspaceId: string, bindingId: string) {
    const binding = await this.requireBinding(workspaceId, bindingId);
    // Use the start of the read window as the next cursor. An event changed
    // after Google's response but before this method finishes must be included
    // again next poll, never skipped by an end-of-run timestamp.
    const syncStartedAt = new Date();
    let pulled = 0;
    let deleted = 0;
    let conflicts = 0;
    let synced = 0;
    let skipped = 0;
    try {
      if (binding.direction === 'pull' || binding.direction === 'two_way') {
        const result = await this.pullFromGoogle(binding);
        pulled = result.pulled;
        deleted = result.deleted;
        conflicts = result.conflicts;
      }

      if (binding.direction === 'push' || binding.direction === 'two_way') {
        const rows = await this.db.query.records.findMany({
          where: and(eq(records.databaseId, binding.databaseId), isNull(records.deletedAt)),
        });
        for (const row of rows) {
          const result = await this.pushRecord(binding, row);
          if (result === 'synced') synced += 1;
          else skipped += 1;
        }
      }
    } catch (error) {
      await this.recordBindingError(binding.id, error);
      throw error;
    }
    await this.db
      .update(calendarSyncBindings)
      .set({
        lastSyncAt: syncStartedAt,
        lastError:
          conflicts > 0
            ? `${conflicts} simultaneous edit conflict${conflicts === 1 ? '' : 's'} resolved by last-write-wins`
            : null,
      })
      .where(eq(calendarSyncBindings.id, binding.id));
    return { synced, skipped, pulled, deleted, conflicts };
  }

  private async handleRecordEvent(event: DomainEvent): Promise<void> {
    const bindings = await this.db.query.calendarSyncBindings.findMany({
      where: and(
        eq(calendarSyncBindings.workspaceId, event.workspaceId),
        eq(calendarSyncBindings.databaseId, event.databaseId),
        eq(calendarSyncBindings.status, 'active'),
      ),
    });
    for (const binding of bindings) {
      if (binding.direction !== 'push' && binding.direction !== 'two_way') continue;
      try {
        if (event.type === 'record_deleted') {
          await this.deleteEventForRecord(binding, event.recordId);
          continue;
        }
        const row = await this.db.query.records.findFirst({
          where: and(
            eq(records.id, event.recordId),
            eq(records.databaseId, event.databaseId),
            isNull(records.deletedAt),
          ),
        });
        if (row) await this.pushRecord(binding, row);
        await this.db
          .update(calendarSyncBindings)
          .set({ lastSyncAt: new Date(), lastError: null })
          .where(eq(calendarSyncBindings.id, binding.id));
      } catch (error) {
        await this.recordBindingError(binding.id, error);
        throw error;
      }
    }
  }

  private async pollInboundBindings(): Promise<void> {
    const bindings = await this.db.query.calendarSyncBindings.findMany({
      where: and(
        eq(calendarSyncBindings.status, 'active'),
        inArray(calendarSyncBindings.direction, ['pull', 'two_way']),
      ),
    });
    for (const binding of bindings) {
      try {
        await this.syncBinding(binding.workspaceId, binding.id);
      } catch (error) {
        await this.recordBindingError(binding.id, error);
        this.logger.warn(
          `calendar polling failed for binding ${binding.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async pullFromGoogle(
    binding: Binding,
  ): Promise<{ pulled: number; deleted: number; conflicts: number }> {
    const auth = await this.calendarAuth(binding.workspaceId, binding.connectionId);
    const selectedFields = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, binding.databaseId), isNull(fields.deletedAt)),
    });
    const byId = new Map(selectedFields.map((field) => [field.id, field]));
    const startField = byId.get(binding.startFieldId);
    if (!startField) throw new BadRequestException('Mapped start field no longer exists');
    const endField = binding.endFieldId ? byId.get(binding.endFieldId) : undefined;
    const descriptionField = binding.descriptionFieldId
      ? byId.get(binding.descriptionFieldId)
      : undefined;

    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        singleEvents: 'true',
        showDeleted: 'true',
        maxResults: '2500',
      });
      if (binding.lastSyncAt) query.set('updatedMin', binding.lastSyncAt.toISOString());
      if (pageToken) query.set('pageToken', pageToken);
      const page = await this.googleJson<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        `${API}/calendars/${encodeURIComponent(binding.calendarId)}/events?${query}`,
        auth,
      );
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    let pulled = 0;
    let deleted = 0;
    let conflicts = 0;
    for (const event of events) {
      if (!event.id) continue;
      const link = await this.db.query.calendarEventLinks.findFirst({
        where: and(
          eq(calendarEventLinks.bindingId, binding.id),
          eq(calendarEventLinks.externalEventId, event.id),
        ),
      });
      const embeddedRecordId = event.extendedProperties?.private?.storyos_record_id;
      const recordId = link?.recordId ?? embeddedRecordId;
      let record = recordId
        ? await this.db.query.records.findFirst({
            where: and(eq(records.id, recordId), eq(records.databaseId, binding.databaseId)),
          })
        : undefined;

      if (event.status === 'cancelled') {
        if (record && !record.deletedAt) {
          await this.recordsService.softDelete(
            binding.workspaceId,
            binding.databaseId,
            record.id,
            binding.createdBy ?? 'calendar-sync',
            INBOUND_SYNC_DEPTH,
          );
          deleted += 1;
        }
        if (link) {
          await this.db.delete(calendarEventLinks).where(eq(calendarEventLinks.id, link.id));
        }
        continue;
      }
      if (!event.start?.date && !event.start?.dateTime) continue;

      const parsedExternalUpdatedAt = event.updated ? new Date(event.updated) : new Date();
      const externalUpdatedAt = Number.isNaN(parsedExternalUpdatedAt.getTime())
        ? new Date()
        : parsedExternalUpdatedAt;
      const externalChanged = !link || !link.lastSyncedAt || externalUpdatedAt > link.lastSyncedAt;
      const localChanged = Boolean(
        record && link?.lastSyncedAt && record.updatedAt > link.lastSyncedAt,
      );
      if (externalChanged && localChanged) {
        conflicts += 1;
        if (record!.updatedAt > externalUpdatedAt) {
          await this.pushRecord(binding, record!);
          continue;
        }
      }
      if (!externalChanged && record) continue;

      const input: Record<string, unknown> = {
        name: event.summary?.trim() || 'Untitled Google Calendar event',
        [startField.apiName]: googleEventStart(event),
      };
      if (endField) input[endField.apiName] = googleEventEnd(event);
      if (descriptionField) {
        input[descriptionField.apiName] =
          descriptionField.type === 'rich_text'
            ? markdownToBlocks(event.description ?? '')
            : (event.description ?? '');
      }

      if (record && !record.deletedAt) {
        await this.recordsService.update(
          binding.workspaceId,
          binding.databaseId,
          record.id,
          input,
          binding.createdBy ?? 'calendar-sync',
          INBOUND_SYNC_DEPTH,
        );
      } else {
        const created = await this.recordsService.create(
          binding.workspaceId,
          binding.databaseId,
          input,
          binding.createdBy,
          INBOUND_SYNC_DEPTH,
        );
        record = await this.db.query.records.findFirst({ where: eq(records.id, created.id) });
      }
      if (!record) continue;
      await this.db
        .insert(calendarEventLinks)
        .values({
          bindingId: binding.id,
          recordId: record.id,
          externalEventId: event.id,
          externalUpdatedAt,
          externalAllDay: Boolean(event.start?.date),
          contentHash: null,
          lastSyncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [calendarEventLinks.bindingId, calendarEventLinks.externalEventId],
          set: {
            recordId: record.id,
            externalUpdatedAt,
            externalAllDay: Boolean(event.start?.date),
            contentHash: null,
            lastSyncedAt: new Date(),
          },
        });
      pulled += 1;
    }
    return { pulled, deleted, conflicts };
  }

  private async pushRecord(
    binding: Binding,
    row: typeof records.$inferSelect,
  ): Promise<'synced' | 'skipped'> {
    const values = row.values as Record<string, unknown>;
    const startValue = values[binding.startFieldId];
    const existing = await this.db.query.calendarEventLinks.findFirst({
      where: and(
        eq(calendarEventLinks.bindingId, binding.id),
        eq(calendarEventLinks.recordId, row.id),
      ),
    });
    if (typeof startValue !== 'string' || !startValue) {
      if (existing) await this.deleteEvent(binding, existing.externalEventId, row.id);
      return 'skipped';
    }

    const endValue = binding.endFieldId ? values[binding.endFieldId] : undefined;
    const descriptionValue = binding.descriptionFieldId
      ? values[binding.descriptionFieldId]
      : undefined;
    const event = {
      summary: row.title || 'Untitled StoryOS record',
      description: calendarDescriptionText(descriptionValue),
      ...calendarEventDates(startValue, endValue, existing?.externalAllDay === true),
      extendedProperties: {
        private: {
          storyos_binding_id: binding.id,
          storyos_record_id: row.id,
        },
      },
    };
    const contentHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    if (existing?.contentHash === contentHash) return 'skipped';

    const auth = await this.calendarAuth(binding.workspaceId, binding.connectionId);
    const url = existing
      ? `${API}/calendars/${encodeURIComponent(binding.calendarId)}/events/${encodeURIComponent(
          existing.externalEventId,
        )}`
      : `${API}/calendars/${encodeURIComponent(binding.calendarId)}/events`;
    const result = await this.googleJson<GoogleEvent>(url, auth, {
      method: existing ? 'PATCH' : 'POST',
      body: JSON.stringify(event),
    });
    if (!result.id) throw new UnprocessableEntityException('Google returned no event id');
    const externalUpdatedAt = result.updated ? new Date(result.updated) : null;
    await this.db
      .insert(calendarEventLinks)
      .values({
        bindingId: binding.id,
        recordId: row.id,
        externalEventId: result.id,
        externalUpdatedAt,
        externalAllDay: isAllDayStoryOsValue(startValue, existing?.externalAllDay === true),
        contentHash,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [calendarEventLinks.bindingId, calendarEventLinks.recordId],
        set: {
          externalEventId: result.id,
          externalUpdatedAt,
          externalAllDay: isAllDayStoryOsValue(startValue, existing?.externalAllDay === true),
          contentHash,
          lastSyncedAt: new Date(),
        },
      });
    return 'synced';
  }

  private async deleteEventForRecord(binding: Binding, recordId: string) {
    const link = await this.db.query.calendarEventLinks.findFirst({
      where: and(
        eq(calendarEventLinks.bindingId, binding.id),
        eq(calendarEventLinks.recordId, recordId),
      ),
    });
    if (link) await this.deleteEvent(binding, link.externalEventId, recordId);
  }

  private async deleteEvent(binding: Binding, externalEventId: string, recordId: string) {
    const auth = await this.calendarAuth(binding.workspaceId, binding.connectionId);
    const response = await this.fetcher(
      `${API}/calendars/${encodeURIComponent(binding.calendarId)}/events/${encodeURIComponent(
        externalEventId,
      )}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${auth.access_token}` },
      },
    );
    if (response.status !== 204 && response.status !== 404) {
      throw new UnprocessableEntityException(
        `Google Calendar delete failed (HTTP ${response.status})`,
      );
    }
    await this.db
      .delete(calendarEventLinks)
      .where(
        and(
          eq(calendarEventLinks.bindingId, binding.id),
          eq(calendarEventLinks.recordId, recordId),
        ),
      );
  }

  private async calendarAuth(workspaceId: string, connectionId: string) {
    const connection = await this.connectionsService.getDecryptedAuth(workspaceId, connectionId);
    if (connection.provider !== 'google-calendar') {
      throw new BadRequestException('Select a Google Calendar connection');
    }
    const auth = connection.auth as Partial<GoogleAuth>;
    if (!auth.access_token) {
      throw new UnprocessableEntityException('Google Calendar connection has no access token');
    }
    return auth as GoogleAuth;
  }

  private async requireBinding(workspaceId: string, bindingId: string) {
    const binding = await this.db.query.calendarSyncBindings.findFirst({
      where: and(
        eq(calendarSyncBindings.id, bindingId),
        eq(calendarSyncBindings.workspaceId, workspaceId),
      ),
    });
    if (!binding) throw new NotFoundException('Calendar binding not found');
    return binding;
  }

  private async recordBindingError(bindingId: string, error: unknown) {
    await this.db
      .update(calendarSyncBindings)
      .set({
        lastError:
          error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      })
      .where(eq(calendarSyncBindings.id, bindingId));
  }

  private async googleJson<T>(
    url: string,
    auth: GoogleAuth,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const response = await this.fetcher(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body,
    });
    if (response.status < 200 || response.status >= 300) {
      const text = await response.text();
      throw new UnprocessableEntityException(
        `Google Calendar request failed (HTTP ${response.status})${
          text ? `: ${text.slice(0, 300)}` : ''
        }`,
      );
    }
    return (await response.json()) as T;
  }
}

/** Google all-day event ends are exclusive; StoryOS date ranges are inclusive. */
export function calendarEventDates(start: string, rawEnd: unknown, preserveAllDay = false) {
  if (isAllDayStoryOsValue(start, preserveAllDay)) {
    const startDay = start.slice(0, 10);
    const end =
      typeof rawEnd === 'string' && isAllDayStoryOsValue(rawEnd, preserveAllDay)
        ? rawEnd.slice(0, 10)
        : startDay;
    const exclusiveEnd = new Date(`${end}T00:00:00Z`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    return {
      start: { date: startDay },
      end: { date: exclusiveEnd.toISOString().slice(0, 10) },
    };
  }
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) {
    throw new BadRequestException('Mapped start field contains an invalid date');
  }
  const parsedEnd =
    typeof rawEnd === 'string' ? new Date(rawEnd) : new Date(startDate.getTime() + 60 * 60 * 1000);
  const endDate =
    Number.isNaN(parsedEnd.getTime()) || parsedEnd <= startDate
      ? new Date(startDate.getTime() + 60 * 60 * 1000)
      : parsedEnd;
  return {
    start: { dateTime: startDate.toISOString() },
    end: { dateTime: endDate.toISOString() },
  };
}

function isAllDayStoryOsValue(value: string, preserveAllDay: boolean): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  return preserveAllDay && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value);
}

export function calendarDescriptionText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) return blocksToMarkdown(value) || undefined;
  return undefined;
}

export function googleEventStart(event: GoogleEvent): string {
  const value = event.start?.dateTime ?? event.start?.date;
  if (!value) throw new BadRequestException('Google event has no start date');
  return value;
}

/** Google all-day ends are exclusive; StoryOS stores the final included day. */
export function googleEventEnd(event: GoogleEvent): string | null {
  if (event.end?.dateTime) return event.end.dateTime;
  if (!event.end?.date) return null;
  const inclusive = new Date(`${event.end.date}T00:00:00Z`);
  if (Number.isNaN(inclusive.getTime())) return null;
  inclusive.setUTCDate(inclusive.getUTCDate() - 1);
  return inclusive.toISOString().slice(0, 10);
}
