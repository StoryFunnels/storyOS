import { z } from 'zod';

export * from './workspaces';
export * from './databases';
export * from './fields';
export * from './record-values';
export * from './query';
export * from './relations';
export * from './views';
export * from './access';

/**
 * Health check response — the first shared schema, proving the
 * schemas package is consumed by both the API and the web app.
 */
export const healthSchema = z.object({
  status: z.literal('ok'),
  name: z.literal('StoryOS'),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;
export * from './formula';
