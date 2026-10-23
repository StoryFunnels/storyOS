'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AuthCard } from '../../(auth)/auth-card';
import { ConsentCard, consentTitle } from '@/components/oauth/consent-card';
import type { ConsentView } from '@/components/oauth/consent-card';
import { signOut, useSession } from '@/lib/auth-client';
import { decideConsent, loadConsent } from '@/lib/oauth-consent';
import type { ConsentDecision } from '@/lib/oauth-consent';

/**
 * #1030 — where an MCP client lands after it asks to connect. The API redirects here with `?request=…`; nothing
 * is granted until the person presses Allow.
 */
function Consent({ onTitle }: { onTitle: (t: string) => void }) {
  const router = useRouter();
  const request = useSearchParams().get('request');
  const { data: session, isPending } = useSession();
  const [view, setView] = useState<ConsentView>({ kind: 'loading' });

  useEffect(() => onTitle(consentTitle(view)), [view, onTitle]);

  useEffect(() => {
    if (isPending) return;
    if (!request) return setView({ kind: 'failed', code: 'invalid' });
    if (!session) {
      router.replace(`/login?next=${encodeURIComponent(`/oauth/consent?request=${request}`)}`);
      return;
    }
    let live = true;
    void loadConsent(request).then((r) => {
      if (live) setView(r.kind === 'ready' ? { kind: 'ready', request: r.request, busy: null } : r);
    });
    return () => {
      live = false;
    };
  }, [isPending, session, request, router]);

  const decide = async (decision: ConsentDecision) => {
    if (view.kind !== 'ready' || !request) return;
    const ready = view.request;
    setView({ kind: 'ready', request: ready, busy: decision });
    const outcome = await decideConsent(request, decision);
    if (outcome.kind === 'failed') return setView({ kind: 'failed', code: outcome.code, workspaceName: ready.workspace.name });
    setView({ kind: 'redirecting', decision });
    window.location.assign(outcome.url);
  };

  const switchAccount = async () => {
    await signOut();
    router.replace(`/login?next=${encodeURIComponent(`/oauth/consent?request=${request ?? ''}`)}`);
  };

  return <ConsentCard view={view} onDecide={(d) => void decide(d)} onSwitchAccount={() => void switchAccount()} />;
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
