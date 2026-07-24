import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { blocksToMarkdown } from '@storyos/schemas';
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

const API = 'https://www.googleapis.com/calendar/v3';

interface GoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
}

interface GoogleEvent {
  id: string;
  updated?: string;
}

export interface CreateCalendarBindingInput {
  connection_id: string;
  database_id: string;
  calendar_id: string;
  calendar_name: string;
  start_field_id: string;
  end_field_id?: string;
  description_field_id?: string;
}

type Binding = typeof calendarSyncBindings.$inferSelect;

@Injectable()
export class CalendarSyncService implements OnModuleInit {
  private readonly logger = new Logger(CalendarSyncService.name);
  fetcher: typeof fetch = fetch;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connectionsService: ConnectionsService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => {
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
    const rows = await this.db.query.records.findMany({
      where: and(eq(records.databaseId, binding.databaseId), isNull(records.deletedAt)),
    });
    let synced = 0;
    let skipped = 0;
    try {
      for (const row of rows) {
        const result = await this.pushRecord(binding, row);
        if (result === 'synced') synced += 1;
        else skipped += 1;
      }
    } catch (error) {
      await this.recordBindingError(binding.id, error);
      throw error;
    }
    await this.db
      .update(calendarSyncBindings)
      .set({ lastSyncAt: new Date(), lastError: null })
      .where(eq(calendarSyncBindings.id, binding.id));
    return { synced, skipped };
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
      ...calendarEventDates(startValue, endValue),
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
        contentHash,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [calendarEventLinks.bindingId, calendarEventLinks.recordId],
        set: {
          externalEventId: result.id,
          externalUpdatedAt,
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
export function calendarEventDates(start: string, rawEnd: unknown) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const end = typeof rawEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawEnd) ? rawEnd : start;
    const exclusiveEnd = new Date(`${end}T00:00:00Z`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    return {
      start: { date: start },
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

export function calendarDescriptionText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) return blocksToMarkdown(value) || undefined;
  return undefined;
}
