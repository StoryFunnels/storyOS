import { z } from 'zod';

/** One tool the Runner found on its machine (ADR-0021 §5). Free-form `capabilities` are kept as reported, size-capped below. */
export const runnerToolSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().max(80).optional(),
  installed: z.boolean(),
  version: z.string().trim().max(60).optional(),
  logged_in: z.boolean().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

/** What a Runner reports about itself, on pairing and on every heartbeat. Compatibility facts, NOT provenance (ADR-0021 §8). */
export const runnerReportSchema = z
  .object({
    machine_name: z.string().trim().min(1).max(120),
    tools: z.array(runnerToolSchema).max(10),
    runner_version: z.string().trim().min(1).max(40),
    protocol_version: z.number().int().min(0).max(1000),
  })
  .refine((v) => JSON.stringify(v.tools).length <= 8_000, { message: 'tools is too large', path: ['tools'] });

export const runnerPairSchema = z
  .object({
    /** What the person typed. Case and a dash are forgiven. */
    code: z.string().trim().min(1).max(32),
    machine_name: z.string().trim().min(1).max(120),
    tools: z.array(runnerToolSchema).max(10),
    runner_version: z.string().trim().min(1).max(40),
    protocol_version: z.number().int().min(0).max(1000),
  })
  .refine((v) => JSON.stringify(v.tools).length <= 8_000, { message: 'tools is too large', path: ['tools'] });

export const runnerToolChoiceSchema = z.object({ tool: z.string().trim().min(1).max(40) });
export const runnerAssignmentSchema = z.object({ runner_id: z.uuid().nullable() });

export type RunnerReport = z.infer<typeof runnerReportSchema>;
export type RunnerPairInput = z.infer<typeof runnerPairSchema>;
