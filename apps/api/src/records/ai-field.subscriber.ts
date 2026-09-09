import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AiFieldConfig } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, records, selectOptions } from '../db/schema';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { JobRunnerService } from '../automations/job-runner.service';
import type { JobHelpers } from '../automations/job-runner.service';
import { defaultManagedAiClient } from '../agents/managed-ai-client';
import type { ManagedAiClient } from '../agents/managed-ai-client';
import { renderAiPrompt } from './ai-field-prompt';

interface AiFieldRecomputePayload {
  workspaceId: string;
  databaseId: string;
  recordId: string;
  fieldId: string;
}

/** Suffixed sibling keys on `computed_values`, alongside the field's own
 * value — flat, not nested, so the jsonb `||` merge every writer here uses
 * never has to reconcile a nested object across concurrent writes (#571). */
const computedAtKey = (fieldId: string) => `${fieldId}:computed_at`;
const errorKey = (fieldId: string) => `${fieldId}:error`;

/**
 * #571 — an AI-computed field's recompute dispatch. Mirrors
 * WriteBackSubscriber's shape exactly: subscribe to DomainEventsService in
 * onModuleInit, fire-and-forget with its own try/catch so one field's
 * recompute enqueue never touches the write that triggered it. Unlike
 * write-back's DIRECT (non-approval) push, this always goes through
 * JobRunnerService's durable queue — never inline — because an LLM call has
 * real, retriable failure modes (rate limits, timeouts) that a plain
 * fire-and-forget async call would just swallow.
 */
@Injectable()
export class AiFieldSubscriber implements OnModuleInit {
  private readonly logger = new Logger(AiFieldSubscriber.name);

  /** Swappable in tests, same seam as the sibling ManagedAiClient consumers
   * (ManagedAiProposer, Tyron's chat client). */
  client: ManagedAiClient | undefined = defaultManagedAiClient();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly domainEvents: DomainEventsService,
    private readonly jobs: JobRunnerService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => this.handle(event));
    this.jobs.registerExecutor('ai_field_recompute', (payload, helpers) =>
      this.recompute(payload as unknown as AiFieldRecomputePayload, helpers),
    );
  }

  private handle(event: DomainEvent): void {
    if (event.type !== 'record_created' && event.type !== 'record_updated') return;
    void this.enqueueAffected(event).catch((err: unknown) => {
      this.logger.warn(
        `ai field enqueue failed for record ${event.recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * A create has nothing to diff against — every ai field on the database is
   * a candidate, since a fresh record has no prior computed value at all. An
   * update only re-triggers a field whose compiled dependency_field_ids
   * actually intersects THIS write's changed fields (event.changedFieldIds),
   * per the ticket's AC — never per-view-render, never on an unrelated edit.
   */
  private async enqueueAffected(event: DomainEvent): Promise<void> {
    const aiFields = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, event.databaseId), eq(fields.type, 'ai'), isNull(fields.deletedAt)),
    });
    if (aiFields.length === 0) return;

    const changed = event.type === 'record_updated' ? new Set(event.changedFieldIds ?? []) : null;
    for (const field of aiFields) {
      const config = field.config as AiFieldConfig;
      const deps = config.dependency_field_ids ?? [];
      if (changed && !deps.some((id) => changed.has(id))) continue;

      const payload: AiFieldRecomputePayload = {
        workspaceId: event.workspaceId,
        databaseId: event.databaseId,
        recordId: event.recordId,
        fieldId: field.id,
      };
      // Not deduped against a prior recompute of the same record+field on
      // purpose — DomainEventsService fires exactly once per write, so each
      // triggering write earns its own job; randomUUID() only exists to
      // satisfy the queue's UNIQUE idempotency-key constraint.
      await this.jobs.enqueue({
        workspaceId: event.workspaceId,
        ruleId: null,
        runId: null,
        actionIndex: 0,
        kind: 'ai_field_recompute',
        payload: payload as unknown as Record<string, unknown>,
        idempotencyKey: `ai_field:${event.recordId}:${field.id}:${randomUUID()}`,
      });
    }
  }

  private async recompute(payload: AiFieldRecomputePayload, _helpers: JobHelpers): Promise<unknown> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, payload.fieldId), isNull(fields.deletedAt)),
    });
    // The field was deleted or retyped since this job was enqueued — nothing
    // to recompute, and not an error (the job simply arrived late).
    if (!field || field.type !== 'ai') return { skipped: 'field no longer an ai field' };

    const record = await this.db.query.records.findFirst({
      where: and(eq(records.id, payload.recordId), isNull(records.deletedAt)),
    });
    if (!record) return { skipped: 'record deleted' };

    if (!this.client) {
      await this.markFailed(payload, 'Not configured on this instance — an OpenAI API key has not been set.');
      throw new Error('ai field recompute: no managed AI client configured (OPENAI_API_KEY unset)');
    }

    const config = field.config as AiFieldConfig;
    const liveFields = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, payload.databaseId), isNull(fields.deletedAt)),
    });
    const displayToApi = new Map(liveFields.map((f) => [f.displayName, f.apiName]));
    // Prompts read select/workflow HUMAN LABELS, not the stored option id —
    // same reasoning attachFormulas' bag-building already applies.
    const selectFieldIds = liveFields
      .filter((f) => f.type === 'select' || f.type === 'workflow')
      .map((f) => f.id);
    const labelByOption = new Map<string, string>();
    if (selectFieldIds.length > 0) {
      const options = await this.db.query.selectOptions.findMany({
        where: inArray(selectOptions.fieldId, selectFieldIds),
      });
      for (const option of options) labelByOption.set(option.id, option.label);
    }
    const stored = record.values as Record<string, unknown>;
    const promptValues: Record<string, unknown> = {};
    for (const f of liveFields) {
      let value = stored[f.id];
      if ((f.type === 'select' || f.type === 'workflow') && typeof value === 'string') {
        value = labelByOption.get(value) ?? value;
      }
      promptValues[f.apiName] = value;
    }
    const prompt = renderAiPrompt(
      config.prompt,
      { title: record.title, number: record.number, values: promptValues },
      displayToApi,
    );

    let text: string;
    try {
      const completion = await this.client.complete(prompt);
      text = completion.text.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailed(payload, message);
      throw error; // let JobRunnerService's own retry/backoff handle it (#571 reuses it, doesn't reinvent one)
    }

    if (config.output.kind === 'choice' && !config.output.options.includes(text)) {
      const message = `model returned "${text.slice(0, 200)}", not one of the configured choices`;
      await this.markFailed(payload, message);
      // A model that won't follow the constrained output is a real, visible
      // failure — not a retry candidate (retrying the identical prompt won't
      // fix a model that ignored its instructions), so this returns rather
      // than throws.
      return { failed: true, reason: message };
    }

    await this.db
      .update(records)
      .set({
        computedValues: sql`${records.computedValues} || ${JSON.stringify({
          [payload.fieldId]: text,
          [computedAtKey(payload.fieldId)]: new Date().toISOString(),
          [errorKey(payload.fieldId)]: null,
        })}::jsonb`,
      })
      .where(eq(records.id, payload.recordId));

    return { value: text };
  }

  /**
   * A failed recompute leaves the field's LAST GOOD value in place
   * (never blanked) but records the failure alongside it — the API-lane
   * half of the ticket's "three visible cell states" bar (#620 builds the
   * web-side rendering; this is the data it reads).
   */
  private async markFailed(payload: AiFieldRecomputePayload, message: string): Promise<void> {
    await this.db
      .update(records)
      .set({
        computedValues: sql`${records.computedValues} || ${JSON.stringify({
          [errorKey(payload.fieldId)]: message.slice(0, 500),
        })}::jsonb`,
      })
      .where(eq(records.id, payload.recordId))
      .catch(() => undefined);
  }
}
