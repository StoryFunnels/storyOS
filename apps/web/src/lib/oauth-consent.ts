import { API_URL } from './api';

/**
 * #1030 — the MCP OAuth consent screen's ONLY door to the server.
 *
 * The endpoints and payloads below are the contract proposed on the ticket, not yet confirmed by the API:
 *   GET  /api/v1/oauth/consent/:request        -> ConsentRequest, or { code } on failure
 *   POST /api/v1/oauth/consent/:request {decision: 'allow' | 'deny'} -> { redirect_url }, or { code }
 * The API side may end up keyed on better-auth's `consent_code` instead of a request id. When it settles,
 * `consentUrl`, `readConsent` and `readDecision` are the only things that change; the screen and the page
 * speak these types and nothing else.
 */
export interface ConsentScope {
  id: string;
  /** Plain-language, written by the server so the words match what the token will really be allowed to do. */
  label: string;
}

export interface ConsentRequest {
  client_name: string;
  /** Where the code goes if the person allows: the host of the client's registered redirect URI. */
  redirect_host?: string;
  scopes: ConsentScope[];
  workspace: { id: string; name: string };
}

export type ConsentFailure = 'expired' | 'invalid' | 'not_member' | 'unavailable';

export type ConsentLoad =
  | { kind: 'ready'; request: ConsentRequest }
  | { kind: 'failed'; code: ConsentFailure; workspaceName?: string };

export type ConsentDecision = 'allow' | 'deny';

export type ConsentOutcome = { kind: 'redirect'; url: string } | { kind: 'failed'; code: ConsentFailure };

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The URL when it is http(s), else null — the page navigates to whatever the server answers, and `javascript:`
 *  there would run on the app's own origin (the same class as a form's redirect_url, ticket #1032). The check is
 *  on the PARSED protocol, so `JaVaScRiPt:` and a tab inside the scheme do not slip past a prefix test. */
export function httpTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

const failureCode = (body: Record<string, unknown>, status: number): ConsentFailure => {
  if (status >= 500) return 'unavailable';
  const code = body.code;
  if (code === 'expired' || code === 'not_member' || code === 'invalid') return code;
  // Unknown code or a bare 404: the request is not one we can act on. Never guess "ready".
  return 'invalid';
};

export function readConsent(status: number, body: unknown): ConsentLoad {
  const rec = asRecord(body);
  if (status >= 200 && status < 300) {
    const workspace = asRecord(rec.workspace);
    const scopes = Array.isArray(rec.scopes) ? rec.scopes.map(asRecord) : null;
    if (
      typeof rec.client_name === 'string' &&
      rec.client_name.trim() !== '' &&
      typeof workspace.id === 'string' &&
      typeof workspace.name === 'string' &&
      scopes &&
      scopes.every((s) => typeof s.id === 'string' && typeof s.label === 'string')
    ) {
      return {
        kind: 'ready',
        request: {
          client_name: rec.client_name,
          redirect_host: typeof rec.redirect_host === 'string' ? rec.redirect_host : undefined,
          scopes: scopes.map((s) => ({ id: s.id as string, label: s.label as string })),
          workspace: { id: workspace.id, name: workspace.name },
        },
      };
    }
    // A 200 we cannot read is not consent to show: the person would be approving something unnamed.
    return { kind: 'failed', code: 'invalid' };
  }
  const workspace = asRecord(rec.workspace);
  return {
    kind: 'failed',
    code: failureCode(rec, status),
    workspaceName: typeof workspace.name === 'string' ? workspace.name : undefined,
  };
}

export function readDecision(status: number, body: unknown): ConsentOutcome {
  const rec = asRecord(body);
  if (status >= 200 && status < 300) {
    const url = httpTarget(rec.redirect_url);
    return url ? { kind: 'redirect', url } : { kind: 'failed', code: 'invalid' };
  }
  return { kind: 'failed', code: failureCode(rec, status) };
}

const consentUrl = (request: string) => `${API_URL}/api/v1/oauth/consent/${encodeURIComponent(request)}`;

export async function loadConsent(request: string): Promise<ConsentLoad> {
  try {
    const res = await fetch(consentUrl(request), { credentials: 'include' });
    return readConsent(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: 'failed', code: 'unavailable' };
  }
}

export async function decideConsent(request: string, decision: ConsentDecision): Promise<ConsentOutcome> {
  try {
    const res = await fetch(consentUrl(request), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    return readDecision(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: 'failed', code: 'unavailable' };
  }
}
