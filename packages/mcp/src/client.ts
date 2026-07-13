import { createStoryOSClient } from '@storyos/sdk';

/**
 * The StoryOS API client the MCP server talks through — the exact contract the web
 * app uses (MN-076). Auth is a personal access token (mn_pat_…); the API scopes
 * every response to what that token's user can access, so the MCP inherits security.
 */
const defaultBaseUrl = () => process.env.STORYOS_URL ?? 'http://localhost:3001';

/**
 * Build a client for an explicit token — used by the hosted HTTP transport, where
 * each request carries its own PAT in the Authorization header (multi-user).
 */
export function makeClientFor(token: string, baseUrl: string = defaultBaseUrl()) {
  return createStoryOSClient({ baseUrl, token });
}

/** Env-based client for the stdio transport (single token from STORYOS_TOKEN). */
export function makeClient() {
  const token = process.env.STORYOS_TOKEN;
  if (!token) {
    throw new Error(
      'STORYOS_TOKEN is required — create a personal access token (mn_pat_…) in StoryOS ' +
        'Settings → API and set it in the MCP server env.',
    );
  }
  return makeClientFor(token);
}

export type Client = ReturnType<typeof makeClient>;

interface Envelope {
  error?: { code?: string; message?: string; details?: Array<{ path?: string; message: string }> };
}

/**
 * Unwrap an openapi-fetch result, turning the API's typed error envelope into a
 * readable message. Surfacing the server's validation verbatim is the whole
 * anti-hallucination play: a wrong field/value comes back naming the problem so
 * the model self-corrects instead of guessing again.
 */
export async function unwrap<T>(p: Promise<{ data?: unknown; error?: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) {
    const env = error as Envelope;
    const message = env.error?.message ?? (typeof error === 'string' ? error : JSON.stringify(error));
    const details = env.error?.details?.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join('; ');
    throw new Error(details ? `${message} (${details})` : message);
  }
  return data as T;
}
