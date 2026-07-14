import { createStoryOSClient } from '@storyos/sdk';

/**
 * The StoryOS API client the MCP server talks through — the exact contract the web
 * app uses (MN-076). Auth is a personal access token (mn_pat_…); the API scopes
 * every response to what that token's user can access, so the MCP inherits security.
 */
const defaultBaseUrl = () => process.env.STORYOS_URL ?? 'http://localhost:3001';

/** The typed openapi-fetch client the tools issue JSON calls through. */
export type Client = ReturnType<typeof createStoryOSClient>;

/**
 * A request context: the typed client plus the raw baseUrl/token behind it. The
 * token/baseUrl are needed for the few calls openapi-fetch can't model cleanly —
 * notably multipart file upload (attach_file), which posts FormData via fetch.
 */
export interface Ctx {
  client: Client;
  baseUrl: string;
  token: string;
}

/**
 * Build a context for an explicit token — used by the hosted HTTP transport, where
 * each request carries its own PAT/OAuth token in the Authorization header (multi-user).
 */
export function makeClientFor(token: string, baseUrl: string = defaultBaseUrl()): Ctx {
  return { client: createStoryOSClient({ baseUrl, token }), baseUrl, token };
}

/** Env-based context for the stdio transport (single token from STORYOS_TOKEN). */
export function makeClient(): Ctx {
  const token = process.env.STORYOS_TOKEN;
  if (!token) {
    throw new Error(
      'STORYOS_TOKEN is required — create a personal access token (mn_pat_…) in StoryOS ' +
        'Settings → API and set it in the MCP server env.',
    );
  }
  return makeClientFor(token);
}

/**
 * Upload a file to a record's attachments endpoint. openapi-fetch models JSON, not
 * multipart, so this posts a FormData (field "file") with a raw fetch, forwarding the
 * same bearer the client uses. Surfaces the API's typed error envelope on failure.
 */
export async function uploadAttachment(
  ctx: Ctx,
  path: { ws: string; db: string; rec: string },
  file: { filename: string; mime?: string; data: Uint8Array },
): Promise<unknown> {
  const form = new FormData();
  form.append('file', new Blob([file.data as unknown as BlobPart], file.mime ? { type: file.mime } : {}), file.filename);
  const url = `${ctx.baseUrl}/api/v1/workspaces/${path.ws}/databases/${path.db}/records/${path.rec}/attachments`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${ctx.token}` }, body: form });
  const payload = (await res.json().catch(() => undefined)) as Envelope | undefined;
  if (!res.ok) {
    const message = payload?.error?.message ?? `Upload failed (HTTP ${res.status})`;
    const details = payload?.error?.details?.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join('; ');
    throw new Error(details ? `${message} (${details})` : message);
  }
  return payload;
}

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
