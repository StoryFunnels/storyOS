import { createStoryOSClient } from '@storyos/sdk';

// '' (set by the docker build) = same-origin relative calls behind caddy (MN-068);
// the localhost default is for `pnpm dev` where web and api run on separate ports.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// The hosted MCP endpoint shown on the connect pages (#163). Self-host operators
// set NEXT_PUBLIC_MCP_URL to THEIR own MCP origin at build time (like API_URL);
// hosted defaults to mcp.storyos.dev so the hosted app is unchanged.
export const MCP_ORIGIN = process.env.NEXT_PUBLIC_MCP_URL ?? 'https://mcp.storyos.dev';
export const MCP_ENDPOINT = `${MCP_ORIGIN}/mcp`;

/**
 * The ONLY way the web app talks to the backend (CONTRIBUTING.md).
 * Cookie-authenticated: the SDK sends credentials, better-auth sets the cookie.
 */
export const api = createStoryOSClient({ baseUrl: API_URL });

/**
 * The API's own message, not a generic one (MN-119).
 *
 * Errors are `{ error: { code, message, details: [{ path, message }] } }`, and the
 * per-value `details` message is the useful one — "no member \"Nobody\" — use a
 * user id, email, or exact name. Members: …" beats "value rejected", which tells
 * the user nothing about what to do next.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const body = (error ?? {}) as { error?: { message?: string; details?: Array<{ message?: string }> } };
  const detail = body.error?.details?.find((d) => d.message)?.message;
  return detail ?? body.error?.message ?? fallback;
}
