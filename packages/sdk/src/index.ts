import createClient from 'openapi-fetch';
import type { paths } from './generated/schema';

export type { paths } from './generated/schema';

export interface StoryOSClientOptions {
  /** e.g. http://localhost:3001 — the client prefixes /api/v1 itself via paths. */
  baseUrl: string;
  /** Session token or personal access token (mn_pat_...). */
  token?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Typed StoryOS API client, generated from docs/api/openapi.json.
 * The web app is client #1 of this SDK; external scripts use the same thing.
 */
export function createStoryOSClient(options: StoryOSClientOptions) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
    fetch: options.fetch,
    credentials: 'include',
  });
}

export type StoryOSClient = ReturnType<typeof createStoryOSClient>;

/** The single error envelope every endpoint returns (docs/architecture/api-conventions.md). */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<{ path?: string; message: string }>;
    request_id: string;
  };
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ErrorEnvelope).error?.code === 'string'
  );
}
