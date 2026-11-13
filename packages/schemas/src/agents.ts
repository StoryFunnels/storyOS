import { z } from 'zod';

/**
 * Ticket #1289 — response shapes of the two agent READ endpoints the agent page is built from. They live here (not only in the
 * controller) so the generated SDK carries a real type instead of `unknown`: `/scope` shipped with an empty one (ticket #1195).
 */

/** GET /workspaces/{ws}/agents/{agent}/scope — where the agent works, resolved NOW (ticket #1195, narrowed by ticket #1296). */
export const agentScopeResponseSchema = z.object({
  agent_id: z.uuid(),
  /** True when the agent targets at least one space: its credential is then bound to exactly `databases`. */
  enforced: z.boolean(),
  spaces: z.array(z.object({ id: z.uuid(), name: z.string() })),
  databases: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      space_id: z.uuid(),
      /** Named directly in the agent's Target databases, or reached through a targeted space. Both reads as `database`. */
      via: z.enum(['database', 'space']),
    }),
  ),
  /** Entries that matched nothing, or a personal space: listed so the manager can see why. */
  unresolved: z.array(z.string()),
  /** How many databases the manager's access removed (their names are not listed). */
  withheld_count: z.number().int().min(0),
});
export type AgentScopeResponse = z.infer<typeof agentScopeResponseSchema>;

/**
 * The database a wake source sits on. `name` is null when the database no longer exists (`exists: false`), so a person can see a
 * dangling source without its id standing in for a name. `is_system` databases are NAMED only: no field or option inside one is
 * ever resolved into a label here (ticket #1296 rule: a system database is named, never described).
 */
export const wakeSourceDatabaseSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  exists: z.boolean(),
  is_system: z.boolean(),
});

/** A field or option a source points at: `name` is null once it was deleted (or when it sits in a system database). */
export const wakeSourceRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

/** One record of the Agent Triggers database whose agent is this one. */
export const agentTriggerWakeSourceSchema = z.object({
  kind: z.literal('agent_trigger'),
  /** The trigger record's id. */
  id: z.uuid(),
  /** `state`: a record entering `state_option` of `state_field` wakes the agent. `relation`: a record linking `relation_field` to the agent does. */
  binding: z.enum(['state', 'relation']),
  database: wakeSourceDatabaseSchema,
  state_field: wakeSourceRefSchema.nullable(),
  state_option: wakeSourceRefSchema.nullable(),
  relation_field: wakeSourceRefSchema.nullable(),
  /** True = this trigger never starts a run by itself: a person starts each one (ADR-0010 section 5). */
  human_gate: z.boolean(),
  /** False = installed but switched off (a pack's trigger ships off): it is listed, never hidden. */
  enabled: z.boolean(),
});

/**
 * One automation rule with a run_agent action for this agent. Its condition, prompt and other actions are never part of this.
 *
 * Who may read the rule is the SAME gate as `GET /databases/{db}/automations` (creator on its database; tickets #1280 and #1289, Otto
 * 2026-11-13). A reader without it gets `name`, `id`, `enabled` and `trigger` all null and only `label`: "A rule in <database>". `label` is
 * therefore the one thing to render; `name === null` is how a client tells a withheld rule from a readable one.
 */
export const automationWakeSourceSchema = z.object({
  kind: z.literal('automation'),
  /** The rule's id; null when withheld. */
  id: z.uuid().nullable(),
  /** The rule's name; null when withheld. */
  name: z.string().nullable(),
  /** What to show: the name, or "A rule in <database>" when withheld. */
  label: z.string(),
  /** Whether the rule is on; null when withheld. */
  enabled: z.boolean().nullable(),
  database: wakeSourceDatabaseSchema,
  /** null when withheld. */
  trigger: z
    .object({
      type: z.enum(['record_created', 'record_updated', 'record_linked', 'schedule', 'webhook_received']),
      /** record_updated: the one field watched (null = any field). */
      field: wakeSourceRefSchema.nullable(),
      /** record_linked: the relation field, and whether a link, an unlink, or both (null) fires it. */
      relation_field: wakeSourceRefSchema.nullable(),
      direction: z.enum(['link', 'unlink']).nullable(),
      /** schedule: the cadence as stored (every, minutes, at, weekday(s), between, timezone). */
      schedule: z
        .object({
          every: z.enum(['minutes', 'hour', 'day', 'week']),
          minutes: z.number().optional(),
          at: z.string().optional(),
          weekday: z.number().optional(),
          weekdays: z.array(z.number()).optional(),
          between: z.object({ from: z.string(), to: z.string() }).optional(),
          timezone: z.string().optional(),
        })
        .nullable(),
    })
    .nullable(),
});

/**
 * A way to start the agent that nobody configured: it applies to every agent. Listed so "everything that can start an agent" is
 * literally true. `reason` is the runtime's own wake reason (`apps/api/src/runners/wake.constants.ts`), a string here because that list is
 * owned by the wake code and a second copy in this package would be the drift this entry exists to prevent.
 */
export const builtInWakeSourceSchema = z.object({
  kind: z.literal('built_in'),
  /** The wake reason the runtime records (mention, manual, approval_decided, must_comment, retry, catch_up). Also the entry's id. */
  reason: z.string(),
  title: z.string(),
  description: z.string(),
});

/** GET /workspaces/{ws}/agents/{agent}/wake-sources — everything that can start this agent (ticket #1289). */
export const agentWakeSourcesResponseSchema = z.object({
  agent_id: z.uuid(),
  /** Configured sources (agent triggers, then automation rules), then the built-in ones: the built-in set is the same for any reader. */
  sources: z.array(z.discriminatedUnion('kind', [agentTriggerWakeSourceSchema, automationWakeSourceSchema, builtInWakeSourceSchema])),
  /** Configured sources on databases the caller cannot open: counted, never named. */
  withheld_count: z.number().int().min(0),
});
export type AgentWakeSourcesResponse = z.infer<typeof agentWakeSourcesResponseSchema>;
export type AgentWakeSource = AgentWakeSourcesResponse['sources'][number];
