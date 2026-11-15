import { API_URL, api } from '@/lib/api';

/**
 * Ticket #1302 — the three calls the Join screen makes. The first two are NOT in the generated SDK yet (they arrive with PR 1540's
 * regenerated `schema.ts`), so they are typed here, the way the agent-scope read is. When that PR merges, `InviteDetails` and
 * `joinWithToken` should move onto the generated types and this comment goes.
 *
 *   GET  /api/v1/public/invites/details?token=…   no sign-in; an unknown, malformed, revoked or replaced token is one `not_found` body
 *   POST /api/v1/workspaces { invite_token }      joins and creates NO workspace; the answer is the workspace joined
 *   POST /api/v1/invites/accept { token }         the same accept(), for someone already signed in
 */
export type InviteDetailsStatus = 'valid' | 'expired' | 'used' | 'not_found';

export interface InviteDetails {
  status: InviteDetailsStatus;
  inviter_name: string | null;
  workspace_name: string | null;
  workspace_logo_url: string | null;
  invited_email: string | null;
}

const STATUSES: readonly string[] = ['valid', 'expired', 'used', 'not_found'];
const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Narrows an unknown body to `InviteDetails`; anything else is null, so a proxy's HTML page or a half answer never draws a screen. */
export function parseInviteDetails(body: unknown): InviteDetails | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.status !== 'string' || !STATUSES.includes(b.status)) return null;
  if (![b.inviter_name, b.workspace_name, b.workspace_logo_url, b.invited_email].every(nullableString)) return null;
  return {
    status: b.status as InviteDetailsStatus,
    inviter_name: b.inviter_name as string | null,
    workspace_name: b.workspace_name as string | null,
    workspace_logo_url: b.workspace_logo_url as string | null,
    invited_email: b.invited_email as string | null,
  };
}

export function inviteDetailsUrl(token: string, base: string = API_URL): string {
  return `${base}/api/v1/public/invites/details?token=${encodeURIComponent(token)}`;
}

/** null means "could not find out" (network, rate limit, an answer that is not the contract), which is NOT "not found". */
export async function fetchInviteDetails(token: string, fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init)): Promise<InviteDetails | null> {
  try {
    const res = await fetchImpl(inviteDetailsUrl(token), { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    return parseInviteDetails(await res.json());
  } catch {
    return null;
  }
}

/** What went wrong with an accept, from the API's stable error codes (PR 1540). */
export type JoinFailure = 'not_found' | 'expired' | 'mismatch' | 'already_member' | 'other';

export type JoinResult = { ok: true; workspaceId: string } | { ok: false; failure: JoinFailure };

const CODES: Record<string, JoinFailure> = {
  invite_not_found: 'not_found',
  invite_expired: 'expired',
  invite_email_mismatch: 'mismatch',
  already_a_member: 'already_member',
};

export function joinFailureFrom(error: unknown): JoinFailure {
  const code = (error as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? (CODES[code] ?? 'other') : 'other';
}

/** The request body of the post-sign-in join: the token and NOTHING that could create a workspace. */
export const joinWorkspaceBody = (token: string) => ({ invite_token: token });

/** After a sign-up or sign-in on the Join screen: the onboarding call, with the token, so it can only join. */
export async function joinWithToken(token: string): Promise<JoinResult> {
  const { data, error } = await api.POST('/api/v1/workspaces', { body: joinWorkspaceBody(token) } as never);
  if (error) return { ok: false, failure: joinFailureFrom(error) };
  const id = (data as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? { ok: true, workspaceId: id } : { ok: false, failure: 'other' };
}

/** Signed in as the invited address: the one click. */
export async function acceptInvite(token: string): Promise<JoinResult> {
  const { data, error } = await api.POST('/api/v1/invites/accept', { body: { token } });
  if (error) return { ok: false, failure: joinFailureFrom(error) };
  const id = (data as { workspace_id?: unknown } | undefined)?.workspace_id;
  return typeof id === 'string' ? { ok: true, workspaceId: id } : { ok: false, failure: 'other' };
}
