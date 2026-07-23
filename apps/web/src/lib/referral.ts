import { api, apiErrorMessage } from './api';

/**
 * #33 — referral link attribution. Kept deliberately dumb and best-effort:
 * a person can land on `?ref=<code>` anywhere (a blog post, a shared board,
 * the landing page — not just /signup), so capture happens once, globally,
 * in Providers (mounted at the root layout), and resolution happens later,
 * once, right after sign-up actually creates an account.
 */
const COOKIE_NAME = 'so_ref';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days — first-touch attribution window

/** Reads `?ref=` off the current URL and, if present and no code is already
 * stored (first touch wins), stashes it in a cookie for the signup flow to
 * pick up later. Safe to call on every route mount — it's a no-op once a
 * code is already captured or the query param is absent. */
export function captureReferralCode(): void {
  if (typeof window === 'undefined') return;
  const code = new URLSearchParams(window.location.search).get('ref');
  if (!code) return;
  if (document.cookie.split('; ').some((c) => c.startsWith(`${COOKIE_NAME}=`))) return;
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(code)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

function readReferralCode(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
}

function clearReferralCode(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`;
}

/**
 * Call once, right after `authClient.signUp.email` succeeds (the session
 * cookie is set by then, so this POST is authenticated). Best-effort by
 * design: never throws, never blocks the redirect that follows it — an
 * unattributed sign-up is a missed reward, not a broken account.
 */
export async function attributeCapturedReferral(): Promise<void> {
  const code = readReferralCode();
  if (!code) return;
  try {
    await api.POST('/api/v1/referrals/attribute', { body: { code } });
  } catch (err) {
    // Best-effort — swallow, but leave a trace for support/debugging.
    console.warn(apiErrorMessage(err, 'Referral attribution failed'));
  } finally {
    clearReferralCode();
  }
}
