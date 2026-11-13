'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import posthog from 'posthog-js';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { authClient, useSession } from '@/lib/auth-client';
import { attributeCapturedReferral } from '@/lib/referral';
import { authEventFromSearch, firstTouchProperties, readFirstTouch } from '@/lib/funnel';
import {
  clearHeldInviteToken,
  inviteGoogleCallbacks,
  inviteJoinPath,
  inviteVerificationCallback,
  resetHrefForInvite,
  resolveInviteToken,
  stashInviteToken,
} from '@/lib/invite-join';
import { acceptInvite, fetchInviteDetails, joinWithToken } from '@/lib/invite-api';
import type { JoinFailure, JoinResult } from '@/lib/invite-api';
import { NOT_FOUND_COPY, isUserAlreadyExists, joinFailureMessage, joinModel } from '@/lib/invite-screen';
import type { JoinSession } from '@/lib/invite-screen';
import { Button } from '@/components/ui/button';
import { GoogleIcon } from '@/components/ui/google-icon';
import { JoinView, SignedOutForm } from '@/components/invite/join-view';
import { AuthCard } from '../(auth)/auth-card';

const NO_STORE = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };

/**
 * Ticket #1302 — the Join screen. An invite link opens HERE, not on the generic sign-in: who invited you, to what, the invited email
 * locked, and ONE action. There is no create-workspace step anywhere on this path: a new account joins with `invite_token` on the
 * onboarding call, which can only join, and `/new-workspace` itself refuses to render while this token is held (`newWorkspaceGate`).
 */
function InviteJoin() {
  const router = useRouter();
  const params = useSearchParams();
  const token = resolveInviteToken({
    queryToken: params.get('token'),
    next: params.get('next'),
    store: typeof window === 'undefined' ? NO_STORE : window.sessionStorage,
    now: Date.now(),
  });
  const { data: session, isPending } = useSession();

  const details = useQuery({
    queryKey: ['invite-details', token],
    queryFn: () => fetchInviteDetails(token as string),
    enabled: Boolean(token),
    staleTime: 0,
    retry: false,
  });
  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async () => (await api.GET('/api/v1/auth/providers')).data as { providers: string[] },
  });

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cameFromGoogle = useRef(false);
  const attempted = useRef(false);

  // The marker Google's redirect carries; read before AuthEventBeacon (a parent's effect, so it runs after this one) strips it.
  useEffect(() => {
    cameFromGoogle.current = authEventFromSearch(window.location.search) !== null;
  }, []);

  const loaded = details.data;
  // Hold the token only while the invite can still be used; a dead one must never keep someone away from creating a workspace.
  useEffect(() => {
    if (!token || !loaded) return;
    if (loaded.status === 'valid') stashInviteToken(window.sessionStorage, token, Date.now());
    else clearHeldInviteToken(window.sessionStorage);
  }, [token, loaded]);

  const joinSession: JoinSession = isPending
    ? { status: 'loading' }
    : session?.user
      ? { status: 'signed_in', email: session.user.email }
      : { status: 'signed_out' };

  const model = joinModel({
    details: loaded,
    detailsFailed: details.isFetched && !loaded,
    session: joinSession,
  });

  function land(result: JoinResult) {
    if (result.ok) {
      clearHeldInviteToken(window.sessionStorage);
      posthog.capture('invite_accepted');
      router.replace(`/w/${result.workspaceId}`);
      return;
    }
    handleFailure(result.failure);
  }

  function handleFailure(failure: JoinFailure) {
    if (failure === 'already_member') {
      // Already in: nothing to accept. The entry route finds their workspace; the token is spent as far as this tab goes.
      clearHeldInviteToken(window.sessionStorage);
      router.replace('/');
      return;
    }
    setError(joinFailureMessage(failure, null));
    setBusy(false);
  }

  async function onJoinClick() {
    if (!token) return;
    setBusy(true);
    setError(null);
    land(await acceptInvite(token));
  }

  // Back from Google as the invited address: the sign-in WAS the click, so finish the join instead of asking again.
  useEffect(() => {
    if (model.kind !== 'join_one_click' || !cameFromGoogle.current || attempted.current) return;
    attempted.current = true;
    void onJoinClick();
  }, [model.kind]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || model.kind !== 'join_signed_out') return;
    setBusy(true);
    setError(null);
    const email = model.invitedEmail;

    let authed = false;
    if (mode === 'new') {
      const created = await authClient.signUp.email({
        email,
        password,
        name,
        // the verification email's link lands back here, signed in, still holding the invite
        callbackURL: inviteVerificationCallback(window.location.origin, token),
      });
      if (!created.error) {
        posthog.capture('user_signed_up', { method: 'email', ...firstTouchProperties(readFirstTouch(window.sessionStorage)) });
        await attributeCapturedReferral();
        authed = true;
      } else if (!isUserAlreadyExists(created.error)) {
        setError(created.error.message ?? 'Sign-up failed');
        setBusy(false);
        return;
      }
    }
    if (!authed) {
      // The address already has an account (or the person said so): sign in with the same password box.
      const signedIn = await authClient.signIn.email({ email, password });
      if (signedIn.error) {
        setMode('existing');
        setError(mode === 'existing' ? (signedIn.error.message ?? 'Sign-in failed') : 'That password does not match the account for this email.');
        setBusy(false);
        return;
      }
      posthog.capture('user_logged_in', { method: 'email' });
    }
    // Signed in as the invited address: the onboarding call, with the token, so it can only join.
    land(await joinWithToken(token));
  }

  async function onSwitchAccount() {
    if (!token) return;
    setBusy(true);
    await authClient.signOut();
    setBusy(false);
    // The Join screen again, token kept (URL and held entry), now signed out.
    router.replace(inviteJoinPath(token));
  }

  if (!token) {
    return <JoinView model={{ kind: 'not_found', ...NOT_FOUND_COPY }} signedIn={Boolean(session?.user)} />;
  }

  const google = providers.data?.providers.includes('google') ? (
    <Button
      type="button"
      variant="secondary"
      onClick={() => void authClient.signIn.social({ provider: 'google', ...inviteGoogleCallbacks(window.location.origin, token) })}
    >
      <GoogleIcon className="h-[18px] w-[18px]" />
      Continue with Google
    </Button>
  ) : null;

  return (
    <JoinView
      model={model}
      signedIn={joinSession.status === 'signed_in'}
      onJoin={() => void onJoinClick()}
      onSwitchAccount={() => void onSwitchAccount()}
      busy={busy}
      error={error}
      signedOutForm={
        model.kind === 'join_signed_out' ? (
          <SignedOutForm
            action={model.action}
            invitedEmail={model.invitedEmail}
            mode={mode}
            name={name}
            password={password}
            onName={setName}
            onPassword={setPassword}
            onSubmit={(e) => void onSubmit(e)}
            busy={busy}
            error={error}
            forgotHref={resetHrefForInvite(token)}
            google={google}
          />
        ) : null
      }
    />
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Workspace invitation">
          <p className="m-0 text-body text-muted">Checking your invite…</p>
        </AuthCard>
      }
    >
      <InviteJoin />
    </Suspense>
  );
}
