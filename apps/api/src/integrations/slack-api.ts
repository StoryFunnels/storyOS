import { guardedFetch } from '../common/net-guard';

/**
 * Ticket #1379 - the only Slack Web API methods the link-preview path calls. A closed union on purpose: the URL is built from this
 * and a constant base, never from anything an event, a link or a stored setting carries, so there is no input that can point this
 * client at another host (SSRF), and adding a method is a visible edit here.
 */
export type SlackApiMethod = 'auth.test' | 'chat.unfurl';

const SLACK_API_BASE = 'https://slack.com/api/';

/** Minimal fetch surface, swappable in tests (the same shape idea as `SlackFetcher` in slack.service.ts, one level up: method, not URL). */
export type SlackApiFetcher = (method: SlackApiMethod, token: string, body: unknown) => Promise<{ status: number; text: string }>;

/**
 * The real transport: the guarded, address-pinned fetch (ticket #1034), no redirects followed, a capped response and a deadline.
 * The token travels only in the Authorization header of a request to slack.com.
 */
export const defaultSlackApiFetcher: SlackApiFetcher = async (method, token, body) => {
  const res = await guardedFetch(
    undefined,
    `${SLACK_API_BASE}${method}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    },
    { followRedirects: false, maxBodyBytes: 65_536 },
  );
  return { status: res.status, text: res.text };
};

export type SlackCallResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * One Slack call, never throwing. A failure is a short code from a fixed vocabulary (Slack's own `error` string when it looks like
 * one, else `http_<status>` / `unreachable` / `bad_response`): never the response body and never the token, so whatever logs or
 * returns it cannot leak either.
 */
export async function callSlack(fetcher: SlackApiFetcher, method: SlackApiMethod, token: string, body: unknown): Promise<SlackCallResult> {
  let res: { status: number; text: string };
  try {
    res = await fetcher(method, token, body);
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { ok: false, error: res.status === 200 ? 'bad_response' : `http_${res.status}` };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'bad_response' };
  const data = parsed as Record<string, unknown>;
  if (data.ok === true) return { ok: true, data };
  const code = typeof data.error === 'string' && /^[a-z_]{1,64}$/.test(data.error) ? data.error : `http_${res.status}`;
  return { ok: false, error: code };
}
