import { ProviderError } from '../common/provider-error';

/**
 * Ticket #42/#51 — every reason a post_social job can end up failed, as a stable code. The job's `last_error` stores
 * `[code] a sentence we wrote`; this file is where the codes live so the executors (LinkedIn/X in post-social.action.ts,
 * Meta in post-social-meta.ts) and the publish-state read share one list.
 */
export type PublishFailureCode =
  | 'no_account'
  | 'account_mismatch'
  | 'already_posted'
  | 'too_long'
  | 'no_token'
  | 'wrong_connection'
  | 'auth_refused'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'rejected'
  | 'bad_response'
  // Ticket #51
  | 'reconnect_required'
  | 'media_required'
  | 'media_unsupported'
  // Ticket #60 (YouTube upload)
  | 'quota_exceeded'
  | 'upload_limit'
  | 'no_access'
  | 'video_missing'
  | 'video_unsupported'
  | 'video_too_large'
  | 'bad_metadata';

export function publishFailure(code: PublishFailureCode, message: string, retryable: boolean, retryAfterMs?: number): ProviderError {
  return new ProviderError(`[${code}] ${message}`, { retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
}

export interface PublishFailure {
  code: PublishFailureCode | 'connection_removed' | 'unknown';
  message: string;
}

const KNOWN_CODES = new Set<string>([
  'no_account', 'account_mismatch', 'already_posted', 'too_long', 'no_token', 'wrong_connection', 'auth_refused', 'forbidden',
  'not_found', 'rate_limited', 'provider_unavailable', 'rejected', 'bad_response',
  'reconnect_required', 'media_required', 'media_unsupported',
  'quota_exceeded', 'upload_limit', 'no_access', 'video_missing', 'video_unsupported', 'video_too_large', 'bad_metadata',
]);

/**
 * `last_error` back into the one safe shape the record shows. The executor writes `[code] sentence`; anything else (a row
 * from before that, a runner message, a thrown TypeError) is NOT passed through, because the raw text of an old row can
 * hold a provider's response body. Only an HTTP status is read out of it.
 */
export function parseFailure(lastError: string | null | undefined): PublishFailure | null {
  if (!lastError) return null;
  const tagged = /^\[([a-z_]+)\] ([^\n]{1,300})$/.exec(lastError);
  if (tagged && KNOWN_CODES.has(tagged[1]!)) return { code: tagged[1] as PublishFailureCode, message: tagged[2]! };
  if (/connection no longer exists/i.test(lastError)) return { code: 'connection_removed', message: 'The connection this post uses was removed.' };
  const status = /HTTP (\d{3})/.exec(lastError)?.[1];
  return { code: 'unknown', message: status ? `The network refused the post (HTTP ${status}).` : 'The post did not go out. Open the run for details.' };
}

