import { Check } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import type { ConsentDecision, ConsentFailure, ConsentLoad, ConsentRequest } from '@/lib/oauth-consent';

/** Which workspaces the connection reaches: all of the person's (the default), or the one they pick. */
export type ConsentScopeChoice = 'all' | 'one';

/** #1030 — everything the consent screen can be, as one value, so every state has a test and none is a branch buried in an effect. */
export type ConsentView =
  | { kind: 'loading' }
  | { kind: 'ready'; request: ConsentRequest; scope: ConsentScopeChoice; workspaceId: string | null; busy: ConsentDecision | null }
  | { kind: 'redirecting'; decision: ConsentDecision }
  | { kind: 'failed'; code: ConsentFailure; message?: string };

/** The one workspace to preselect for "One workspace": only when there is exactly one, never a silent pick among several. */
export function defaultWorkspaceId(request: ConsentRequest): string | null {
  return request.workspaces.length === 1 ? request.workspaces[0]!.id : null;
}

/** The screen a freshly loaded request starts as: ALL workspaces, nothing chosen. */
export function readyView(request: ConsentRequest): ConsentView {
  return { kind: 'ready', request, scope: 'all', workspaceId: defaultWorkspaceId(request), busy: null };
}

/**
 * Applying a (re)load to what the person is looking at. Only the FIRST load may set the screen: a later one (a session refetch
 * when the window regains focus re-ran the load) used to replace a ready view and wipe the workspace the person had chosen
 * (#1079). Once the screen is past loading, nothing but the person changes it.
 */
export function applyLoaded(current: ConsentView, loaded: ConsentLoad): ConsentView {
  if (current.kind !== 'loading') return current;
  return loaded.kind === 'ready' ? readyView(loaded.request) : loaded;
}

/** May Allow be pressed? "All" always can; "One workspace" needs one picked. */
export function canAllow(view: Extract<ConsentView, { kind: 'ready' }>): boolean {
  return view.busy === null && (view.scope === 'all' || view.workspaceId !== null);
}

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
  onChange: (patch: { scope?: ConsentScopeChoice; workspaceId?: string | null }) => void;
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

  const { request, busy, workspaceId, scope } = view;
  const several = request.workspaces.length > 1;
  const allWords = request.workspaces.length === 1 ? `All my workspaces (${request.workspaces[0]!.name})` : 'All my workspaces';
  return (
    <div className="flex flex-col gap-5">
      <p className="text-body text-ink-secondary">
        <strong className="font-semibold text-ink">{request.client_name}</strong> is asking to connect to your StoryOS
        account and will send you back to <span className="font-medium text-ink">{request.redirect_host}</span>.
      </p>

      <fieldset className="flex flex-col gap-1.5" disabled={busy !== null}>
        <legend className="mb-1 text-meta font-medium uppercase tracking-wider text-muted">Workspaces it can reach</legend>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-border-default px-3 py-2 has-[:checked]:border-ink">
          <input
            type="radio"
            name="consent-scope"
            className="mt-1 accent-[var(--primary)]"
            checked={scope === 'all'}
            onChange={() => onChange({ scope: 'all' })}
          />
          <span className="flex flex-col">
            <span className="text-body font-medium text-ink">{allWords}</span>
            <span className="text-label text-muted">Including any you join later. Your role and access in each still apply.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-border-default px-3 py-2 has-[:checked]:border-ink">
          <input
            type="radio"
            name="consent-scope"
            className="mt-1 accent-[var(--primary)]"
            checked={scope === 'one'}
            onChange={() => onChange({ scope: 'one', workspaceId: workspaceId ?? defaultWorkspaceId(request) })}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-body font-medium text-ink">One workspace</span>
            <span className="text-label text-muted">It cannot see any other.</span>
            {scope === 'one' &&
              (several ? (
                <Select
                  id="consent-workspace"
                  aria-label="Workspace"
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
              ) : (
                <span id="consent-workspace" className="text-body text-ink">
                  {request.workspaces[0]!.name}
                </span>
              ))}
          </span>
        </label>
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
        It acts as you, with your role and access. To limit which tools it may use, switch them off in {request.client_name}.
        Only continue if you started this connection from {request.client_name}.
      </p>

      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" disabled={busy !== null} onClick={() => onDecide('deny')}>
          {busy === 'deny' ? 'Cancelling…' : 'Deny'}
        </Button>
        <Button className="flex-1" disabled={!canAllow(view)} onClick={() => onDecide('allow')}>
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </Button>
      </div>
      {scope === 'one' && workspaceId === null && <p className="-mt-3 text-label text-muted">Choose a workspace to allow.</p>}
    </div>
  );
}
