import { Check } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { ConsentDecision, ConsentFailure, ConsentRequest } from '@/lib/oauth-consent';

/** #1030 — everything the consent screen can be, as one value, so every state has a test and none is a branch buried in an effect. */
export type ConsentView =
  | { kind: 'loading' }
  | { kind: 'ready'; request: ConsentRequest; busy: ConsentDecision | null }
  | { kind: 'redirecting'; decision: ConsentDecision }
  | { kind: 'failed'; code: ConsentFailure; workspaceName?: string };

export function consentTitle(view: ConsentView): string {
  return view.kind === 'ready' ? `Allow ${view.request.client_name} to connect?` : 'Connection request';
}

const HOME = (
  <Link href="/" className="text-body text-ink underline">
    Go to my workspaces
  </Link>
);

export function ConsentCard({
  view,
  onDecide,
  onSwitchAccount,
}: {
  view: ConsentView;
  onDecide: (decision: ConsentDecision) => void;
  onSwitchAccount: () => void;
}) {
  if (view.kind === 'loading') {
    return (
      <p role="status" className="text-body text-muted">
        Checking this request…
      </p>
    );
  }

  if (view.kind === 'redirecting') {
    return (
      <p role="status" className="text-body text-muted">
        {view.decision === 'allow' ? 'Connecting… sending you back to the app.' : 'Cancelled. Sending you back to the app.'}
      </p>
    );
  }

  if (view.kind === 'failed') {
    const copy: Record<ConsentFailure, { text: string; hint?: string }> = {
      expired: { text: 'This connection request has expired.', hint: 'Start the connection again from the app.' },
      invalid: {
        text: 'This connection request is not valid.',
        hint: 'Nothing was connected. Start the connection again from the app.',
      },
      not_member: {
        text: view.workspaceName
          ? `You are not a member of ${view.workspaceName}.`
          : 'You are not a member of the workspace this app asked for.',
        hint: 'Ask a workspace admin to invite you, or sign in with the account that belongs to it.',
      },
      unavailable: { text: 'StoryOS could not load this request.', hint: 'Nothing was connected. Try again in a moment.' },
    };
    const { text, hint } = copy[view.code];
    return (
      <div className="flex flex-col gap-4">
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-prose font-medium text-ink">{text}</p>
          {hint && <p className="text-body text-ink-secondary">{hint}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {view.code === 'not_member' && (
            <Button variant="secondary" onClick={onSwitchAccount}>
              Use another account
            </Button>
          )}
          {HOME}
        </div>
      </div>
    );
  }

  const { request, busy } = view;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-body text-ink-secondary">
        <strong className="font-semibold text-ink">{request.client_name}</strong> is asking to connect to your StoryOS
        account{request.redirect_host ? <> and will send you back to <span className="font-medium text-ink">{request.redirect_host}</span></> : null}.
      </p>

      <dl className="flex flex-col gap-1 rounded-[var(--radius-control)] border border-border-default px-3 py-2.5">
        <dt className="text-meta font-medium uppercase tracking-wider text-muted">Workspace</dt>
        <dd className="text-prose font-medium text-ink">{request.workspace.name}</dd>
      </dl>

      <div className="flex flex-col gap-2">
        <p className="text-meta font-medium uppercase tracking-wider text-muted">It will be able to</p>
        {request.scopes.length === 0 ? (
          <p className="text-body text-ink-secondary">Nothing beyond signing in as you.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {request.scopes.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-body text-ink">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-label text-muted">Only continue if you started this connection from {request.client_name}.</p>

      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" disabled={busy !== null} onClick={() => onDecide('deny')}>
          {busy === 'deny' ? 'Cancelling…' : 'Deny'}
        </Button>
        <Button className="flex-1" disabled={busy !== null} onClick={() => onDecide('allow')}>
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </Button>
      </div>
    </div>
  );
}
