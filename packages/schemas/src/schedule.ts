import { z } from 'zod';
import { scheduleProblems } from './schedule-cadence';

export * from './schedule-cadence';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24-hour)');

/** #1194 — the schedule trigger's zod shape; the rules (floor, window, zone) are scheduleProblems in the zod-free schedule-cadence.ts. */
export const scheduleTriggerSchema = z
  .object({
    type: z.literal('schedule'),
    every: z.enum(['minutes', 'hour', 'day', 'week']),
    /** every: 'minutes' only; at least 10 (a 422 with a reason, not a silent clamp). */
    minutes: z.number().optional(),
    at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    /** 0 = Sunday ... 6 = Saturday. Mon-Fri = [1,2,3,4,5]. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    between: z.object({ from: hhmm, to: hhmm }).optional(),
    /** IANA zone every time/window/weekday is evaluated in. Omitted = the server's zone (how rules behaved before this). */
    timezone: z.string().optional(),
  })
  .superRefine((t, ctx) => {
    for (const message of scheduleProblems(t)) ctx.addIssue({ code: 'custom', message });
  });
