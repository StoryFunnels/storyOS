import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';
import { AgentsService } from './agents.service';

/**
 * Loop guard (a): mirrors the automations engine. An agent's write carries the
 * triggering event's depth + 1, so a transition → run → write-back → transition
 * cycle dies after two hops instead of spinning (ADR-0010 §5).
 */
const MAX_DEPTH = 2;

/**
 * Loop guard (b): per-record, per-agent cooldown. Depth alone can't stop a
 * cycle that re-enters through a *fresh* user-depth event (e.g. an agent writing
 * through a path that resets lineage), so the same agent may not fire twice on
 * the same record inside this window regardless of depth.
 */
const DEFAULT_COOLDOWN_MS = 5_000;

/** How many binding records one workspace's dispatcher scans per event. */
const MAX_BINDINGS = 200;

/**
 * State-transition dispatcher (#212, ADR-0010 §5) — the core loop of the
 * Agentic OS: a record enters state S → the bound agent runs with that record
 * as context.
 *
 * Subscribes to the in-process domain-event bus exactly like AutomationsService.
 * The bus emits **once per write, after commit**, and we fire only when the
 * bound state field is among that write's changed fields — so one transition
 * dispatches exactly one run, and a re-save of a record already sitting in the
 * state dispatches nothing.
 */
@Injectable()
export class AgentTriggerSubscriber implements OnModuleInit {
  private readonly logger = new Logger(AgentTriggerSubscriber.name);

  /** `${agentId}:${recordId}` → epoch ms until which that pair may not re-fire. */
  private readonly cooldowns = new Map<string, number>();

  /** Serializes handling per record, so runs for one record never interleave. */
  private readonly chains = new Map<string, Promise<void>>();

  /** Overridable so tests can exercise the cooldown without sleeping. */
  cooldownMs = DEFAULT_COOLDOWN_MS;

  constructor(
    private readonly agents: AgentsService,
    private readonly recordsService: RecordsService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit() {
    this.domainEvents.subscribe((event) => this.dispatch(event));
  }

  dispatch(event: DomainEvent): void {
    const chain = this.chains.get(event.recordId) ?? Promise.resolve();
    const next = chain
      // A dispatch failure must never crash the subscriber or the write that
      // emitted the event — the bus isolates listeners, and this isolates the
      // async tail the bus can't see.
      .then(() => this.handle(event))
      .catch((error) => this.logger.warn(`agent trigger dispatch failed: ${String(error)}`))
      .finally(() => {
        if (this.chains.get(event.recordId) === next) this.chains.delete(event.recordId);
      });
    this.chains.set(event.recordId, next);
  }

  /** Test hook: awaits the record's chain so assertions see dispatch effects. */
  async settle(recordId: string): Promise<void> {
    await (this.chains.get(recordId) ?? Promise.resolve());
  }

  private async handle(event: DomainEvent): Promise<void> {
    // A state transition is a create-into-a-state or an update-of-the-state.
    // record_linked is not a state change.
    if (event.type !== 'record_created' && event.type !== 'record_updated') return;

    const { agentsDb, runsDb, triggersDb } = await this.agents.findPackDbs(event.workspaceId);
    // No pack → no agents → nothing to dispatch. The overwhelmingly common case,
    // and it costs one indexed query.
    if (!agentsDb || !runsDb || !triggersDb) return;
    // Never let the pack's own bookkeeping writes (creating a Run) feed back in.
    if (event.databaseId === runsDb.id || event.databaseId === triggersDb.id) return;

    const bindings = await this.recordsService.list(triggersDb.id, { limit: MAX_BINDINGS });
    const armed = bindings.data.filter(
      (b) => b.values['enabled'] === true && b.values['database'] === event.databaseId,
    );
    if (armed.length === 0) return;

    this.prune();

    const defs = await this.recordsService.fieldDefs(event.databaseId);
    let record: ProjectedRecord | null = null;

    for (const binding of armed) {
      const stateFieldId = binding.values['state_field'] as string | undefined;
      const stateOptionId = binding.values['state_option'] as string | undefined;
      if (!stateFieldId || !stateOptionId) continue;

      // ── Human gate (ADR-0010 §5) ────────────────────────────────────────────
      // A gated state never auto-fires an agent *out* of it. Checkpoints are
      // first-class: only a human move advances a gated state, so we skip
      // before doing any work at all.
      if (binding.values['human_gate'] === true) continue;

      // ── Exactly-once per transition ─────────────────────────────────────────
      // The bus emits once per write. Requiring the state field to be among the
      // *changed* fields is what makes this a transition rather than a re-save:
      // editing any other field on a record already in the state fires nothing.
      if (event.type === 'record_updated' && !event.changedFieldIds?.includes(stateFieldId)) {
        continue;
      }

      const def = defs.find((d) => d.id === stateFieldId);
      // Validated at create time (#211), but schema drifts — a deleted or
      // retyped field disarms the binding instead of throwing.
      if (!def || def.type !== 'select') continue;

      record ??= await this.recordsService.get(event.databaseId, event.recordId).catch(() => null);
      if (!record) return; // deleted between commit and dispatch

      // The transition must land *on the bound option*, not merely touch the field.
      if (record.values[def.api_name] !== stateOptionId) continue;

      const agentRef = (binding.values['agent'] as Array<{ id: string }> | undefined)?.[0];
      if (!agentRef) continue;

      // ── Loop guard (a): depth ───────────────────────────────────────────────
      if (event.depth >= MAX_DEPTH) {
        this.logger.warn(
          `agent trigger ${binding.id}: depth ${event.depth} — loop guard, not dispatching`,
        );
        continue;
      }

      const agentRecord = await this.recordsService
        .get(agentsDb.id, agentRef.id)
        .catch(() => null);
      // A disabled agent is a definition, not a runnable thing — and an unset
      // checkbox is not enabled either (same rule as the manual path).
      if (!agentRecord || agentRecord.values['enabled'] !== true) continue;

      const owner = await this.agents.resolveAgentOwner(event.workspaceId, agentRecord);
      if (!owner) {
        // The owner left the workspace: there is no identity to run as, and
        // running as anyone else would breach least privilege (ADR-0010 §2).
        this.logger.warn(
          `agent ${agentRecord.id}: owner is not a member of this workspace — not dispatching`,
        );
        continue;
      }

      // ── Loop guard (b): per-record, per-agent cooldown ──────────────────────
      // Claimed last, and only for a dispatch we are actually about to make, so
      // a skipped run never burns the window.
      const key = `${agentRecord.id}:${event.recordId}`;
      const until = this.cooldowns.get(key);
      if (until !== undefined && until > Date.now()) continue;
      this.cooldowns.set(key, Date.now() + this.cooldownMs);

      // Dispatch through the shared run path: run class stamped before any step
      // executes, failures land as a Failed Run with the error in Steps rather
      // than as an exception (ADR-0010 §3, §5).
      await this.agents.dispatchRun({
        workspaceId: event.workspaceId,
        agentsDb,
        runsDb,
        agentRecord,
        trigger: 'State change',
        inputRecordId: event.recordId,
        owner,
        // Unattended: retry a transient failure twice with backoff before the
        // Run lands as the dead-letter.
        retries: 2,
        depth: event.depth + 1,
      });
    }
  }

  /** Drop expired cooldowns so the map can't grow without bound. */
  private prune() {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(key);
    }
  }
}
