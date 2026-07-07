import { z } from 'zod';

export * from './workspaces';
export * from './databases';

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
