'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AuthCard } from '../../(auth)/auth-card';
import { ConsentCard, applyLoaded, consentTitle } from '@/components/oauth/consent-card';
import type { ConsentView } from '@/components/oauth/consent-card';
import { signOut, useSession } from '@/lib/auth-client';
import { decideConsent, loadConsent } from '@/lib/oauth-consent';
import type { ConsentScopeChoice } from '@/components/oauth/consent-card';
import type { ConsentDecision } from '@/lib/oauth-consent';

/**
 * #1030 — where an MCP client lands after it asks to connect. better-auth redirects here with `?consent_code=…`;
 * nothing is granted until the person presses Allow; the connection reaches all of their workspaces, or the one they choose (#1079).
 */
function Consent({ onTitle }: { onTitle: (t: string) => void }) {
  const router = useRouter();
  const code = useSearchParams().get('consent_code');
  const { data: session, isPending } = useSession();
  const [view, setView] = useState<ConsentView>({ kind: 'loading' });

  useEffect(() => onTitle(consentTitle(view)), [view, onTitle]);

  const here = () => `/oauth/consent?${new URLSearchParams(window.location.search).toString()}`;

  // Depend on WHETHER someone is signed in, never on the session object: a session refetch (the window regaining focus) hands
  // back a new object, and a load that re-ran for it used to replace the screen and wipe the person's workspace choice (#1079).
  const signedIn = Boolean(session);
  useEffect(() => {
    if (isPending) return;
    if (!code) return setView({ kind: 'failed', code: 'invalid' });
    if (!signedIn) {
      router.replace(`/login?next=${encodeURIComponent(here())}`);
      return;
    }
    let live = true;
    void loadConsent(code).then((r) => {
      if (live) setView((v) => applyLoaded(v, r));
    });
    return () => {
      live = false;
    };
  }, [isPending, signedIn, code, router]);

  const change = (patch: { scope?: ConsentScopeChoice; workspaceId?: string | null }) =>
    setView((v) => (v.kind === 'ready' ? { ...v, ...patch } : v));

  const decide = async (decision: ConsentDecision) => {
    if (view.kind !== 'ready' || !code) return;
    const ready = view;
    setView({ ...ready, busy: decision });
    const outcome = await decideConsent({
      consentCode: code,
      decision,
      // Omitted = all workspaces; only a person who chose "One workspace" sends one.
      workspaceId: ready.scope === 'one' ? (ready.workspaceId ?? undefined) : undefined,
    });
    if (outcome.kind === 'failed') return setView({ kind: 'failed', code: outcome.code, message: outcome.message });
    setView({ kind: 'redirecting', decision });
    window.location.assign(outcome.url);
  };

  const switchAccount = async () => {
    await signOut();
    router.replace(`/login?next=${encodeURIComponent(here())}`);
  };

  return (
    <ConsentCard
      view={view}
      onDecide={(d) => void decide(d)}
      onChange={change}
      onSwitchAccount={() => void switchAccount()}
    />
  );
}

export default function ConsentPage() {
  const [title, setTitle] = useState('Connection request');
  return (
    <AuthCard title={title}>
      <Suspense>
        <Consent onTitle={setTitle} />
      </Suspense>
    </AuthCard>
  );
}
