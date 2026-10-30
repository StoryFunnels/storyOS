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

/** `POST /runner/v1/claim` (ADR-0021 §2): how many wakes the Runner can take, and how long it will wait for one. */
export const wakeClaimSchema = z.object({
  max: z.number().int().min(1).max(10).optional(),
  wait_seconds: z.number().min(0).max(25).optional(),
  /** Claim THIS wake (and get a clear 409 if it is already claimed) instead of the next one in line. */
  wake_id: z.string().max(64).optional(),
});

export const wakeLeaseSchema = z.object({ nonce: z.string().min(1).max(100) });

/** `POST /runner/v1/wakes/{id}/complete`: the adapter result (ADR-0021 §5). `usage` is null when the tool did not say: never zero-filled. */
export const wakeCompleteSchema = z.object({
  nonce: z.string().min(1).max(100),
  exit: z.enum(['ok', 'error', 'limit_reached', 'aborted', 'timeout']),
  usage: z.object({ tokens_in: z.number().int().min(0), tokens_out: z.number().int().min(0) }).nullable().optional(),
  session_id: z.string().max(200).optional(),
  summary: z.string().max(20_000).optional(),
  error: z.string().max(5_000).optional(),
  limit_reached_until: z.iso.datetime().optional(),
  tool_version: z.string().max(60).optional(),
});

export type WakeClaimInput = z.infer<typeof wakeClaimSchema>;
export type WakeCompleteInput = z.infer<typeof wakeCompleteSchema>;
export type RunnerReport = z.infer<typeof runnerReportSchema>;
export type RunnerPairInput = z.infer<typeof runnerPairSchema>;
