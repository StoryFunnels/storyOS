import type { z } from 'zod';

/**
 * #949 — a PATCH whose body carries no recognised key. zod strips unknown keys, so `{}` and `{ nonsense: 1 }` arrive as the
 * same empty patch, and the services turned it into an empty `UPDATE ... SET` that the database refused: a 500, which error
 * monitoring reads as a server fault and which tells an API or MCP caller nothing. It is a request that asks for no change,
 * so it is a 422 that NAMES the accepted fields.
 *
 * Declarative on the schema (not a check in each service) so a new PATCH endpoint gets the same answer by wrapping its schema,
 * and so the message is built from the schema's own keys and cannot drift from what the endpoint accepts. A `null` value is a
 * value (it clears a field); only `undefined` counts as absent. Not for a schema whose "no change" is a legitimate no-op.
 */
export function atLeastOneField<T extends z.ZodObject>(schema: T): T {
  const accepted = Object.keys(schema.shape).join(', ');
  return schema.refine((value) => Object.values(value as Record<string, unknown>).some((v) => v !== undefined), {
    message: `Send at least one field to change. Accepted fields: ${accepted}.`,
  }) as unknown as T;
}
