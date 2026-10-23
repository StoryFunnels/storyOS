import { Check } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import type { ConsentAccess, ConsentDecision, ConsentFailure, ConsentRequest } from '@/lib/oauth-consent';

/** #1030 — everything the consent screen can be, as one value, so every state has a test and none is a branch buried in an effect. */
export type ConsentView =
  | { kind: 'loading' }
  | { kind: 'ready'; request: ConsentRequest; workspaceId: string | null; access: ConsentAccess; busy: ConsentDecision | null }
  | { kind: 'redirecting'; decision: ConsentDecision }
  | { kind: 'failed'; code: ConsentFailure; message?: string };

/** The one workspace to preselect: only when there is exactly one, never a silent pick among several. */
export function defaultWorkspaceId(request: ConsentRequest): string | null {
  return request.workspaces.length === 1 ? request.workspaces[0]!.id : null;
}

export const ACCESS_WORDS: Record<ConsentAccess, { label: string; hint: string }> = {
  read: { label: 'Read only', hint: 'It can look at records and never change them.' },
  write: { label: 'Read and write', hint: 'It can also create, edit and delete records, as you.' },
};

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
  onChange,
  onSwitchAccount,
}: {
  view: ConsentView;
  onDecide: (decision: ConsentDecision) => void;
  onChange: (patch: { workspaceId?: string | null; access?: ConsentAccess }) => void;
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
      expired: {
        text: view.message ?? 'This connection request has expired.',
        hint: 'Nothing was connected. Start the connection again from the app.',
      },
      invalid: {
        text: 'This connection request is not valid.',
        hint: 'Nothing was connected. Start the connection again from the app.',
      },
      no_workspace: {
        text: 'You are not a member of any workspace, so there is nothing to connect this app to.',
        hint: 'Ask a workspace admin to invite you, or sign in with the account that belongs to one.',
      },
      not_a_session: {
        text: 'Sign in as yourself to approve this connection.',
        hint: 'An access token cannot approve a connection on your behalf.',
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
          {(view.code === 'no_workspace' || view.code === 'not_a_session') && (
            <Button variant="secondary" onClick={onSwitchAccount}>
              {view.code === 'no_workspace' ? 'Use another account' : 'Sign in again'}
            </Button>
          )}
          {HOME}
        </div>
      </div>
    );
  }

  const { request, busy, workspaceId, access } = view;
  const only = request.workspaces.length === 1 ? request.workspaces[0]! : null;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-body text-ink-secondary">
        <strong className="font-semibold text-ink">{request.client_name}</strong> is asking to connect to your StoryOS
        account and will send you back to <span className="font-medium text-ink">{request.redirect_host}</span>.
      </p>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="consent-workspace" className="text-meta font-medium uppercase tracking-wider text-muted">
          Workspace it can reach
        </label>
        {only ? (
          <p id="consent-workspace" className="rounded-[var(--radius-control)] border border-border-default px-3 py-2 text-prose font-medium text-ink">
            {only.name}
          </p>
        ) : (
          <Select
            id="consent-workspace"
            value={workspaceId ?? ''}
            disabled={busy !== null}
            onChange={(e) => onChange({ workspaceId: e.target.value || null })}
          >
            <option value="">Choose a workspace</option>
            {request.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        )}
        <p className="text-label text-muted">It cannot see any other workspace.</p>
      </div>

      <fieldset className="flex flex-col gap-1.5" disabled={busy !== null}>
        <legend className="mb-1 text-meta font-medium uppercase tracking-wider text-muted">What it can do</legend>
        {request.access_options.map((opt) => (
          <label
            key={opt}
            className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-border-default px-3 py-2 has-[:checked]:border-ink"
          >
            <input
              type="radio"
              name="consent-access"
              className="mt-1 accent-[var(--primary)]"
              checked={access === opt}
              onChange={() => onChange({ access: opt })}
            />
            <span className="flex flex-col">
              <span className="text-body font-medium text-ink">{ACCESS_WORDS[opt].label}</span>
              <span className="text-label text-muted">{ACCESS_WORDS[opt].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {request.scopes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-meta font-medium uppercase tracking-wider text-muted">It asked for</p>
          <ul className="flex flex-col gap-1">
            {request.scopes.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-body text-ink">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-label text-muted">
        Only continue if you started this connection from {request.client_name}. Allowing replaces how apps you already
        connected reach StoryOS: they stop working until they reconnect.
      </p>

      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" disabled={busy !== null} onClick={() => onDecide('deny')}>
          {busy === 'deny' ? 'Cancelling…' : 'Deny'}
        </Button>
        <Button className="flex-1" disabled={busy !== null || workspaceId === null} onClick={() => onDecide('allow')}>
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </Button>
      </div>
      {workspaceId === null && <p className="-mt-3 text-label text-muted">Choose a workspace to allow.</p>}
    </div>
  );
}
