import { z } from 'zod';

export * from './colors';
export * from './descriptions';
export * from './workspaces';
export * from './databases';
export * from './fields';
export * from './record-values';
export * from './query';
export * from './system-fields';
export * from './relations';
export * from './views';
export * from './form-visibility';
export * from './access';

/**
 * Health check response — the first shared schema, proving the
 * schemas package is consumed by both the API and the web app.
 */
export const healthSchema = z.object({
  status: z.literal('ok'),
  name: z.literal('StoryOS'),
  version: z.string(),
  /**
   * #553 — the commit this RUNNING process was actually built from, baked
   * into the image at build time (never read from a deploy-time env file
   * that could lie about a failed rollout). Null outside a Docker build
   * (local dev/test never sets GIT_SHA).
   */
  commit_sha: z.string().nullable(),
  /** #553 — same reasoning, same source, as commit_sha. */
  build_time: z.string().nullable(),
});

export type Health = z.infer<typeof healthSchema>;
export * from './formula';
export * from './webhooks';
export * from './markdown';
export * from './token-scopes';
export * from './architect';
export * from './packs';
export * from './icons';
export * from './connections';
export * from './sources';
export * from './skills';
export * from './billing';
export * from './column-match';
export * from './portal';
