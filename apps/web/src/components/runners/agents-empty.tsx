import { Plus } from 'lucide-react';
import { Quill } from '@/components/quill/quill';
import { Button } from '@/components/ui/button';
import { canHireAgents, canSetupAgents } from '@/lib/runners/access';

/**
 * Ticket #1253 — the Agents list with no agents: Quill, "No agents yet", and exactly ONE way forward, whatever state the workspace
 * is in. A fresh workspace has no Agents database at all (nothing has provisioned it), and hiring needs that database, so there
 * the one action is "Set up agents" (the call the `setup_agents` MCP tool makes); once it lands the screen shows "Hire an agent".
 * Never a dead end and never a pointer to install a pack. A person who cannot set agents up (only admins can) is told whom to ask.
 */
export function AgentsEmpty({
  role,
  hasAgentsDb,
  onHire,
  onSetup,
  setupPending,
  setupError,
}: {
  role: string | undefined;
  hasAgentsDb: boolean;
  onHire: () => void;
  onSetup: () => void;
  setupPending: boolean;
  setupError: string | null;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-[var(--radius-card)] border border-border-default bg-card px-4 pb-6 pt-7 text-center" data-testid="agents-empty">
      <Quill pose="stool" size={88} caption="Nothing to cook yet." captionClassName="max-w-[160px]" />
      <h3 className="m-0 text-prose font-semibold leading-[normal] text-ink">No agents yet</h3>
      {hasAgentsDb ? (
        canHireAgents(role) && (
          <Button type="button" size="sm" onClick={onHire}>
            <Plus className="h-[13px] w-[13px]" aria-hidden />
            Hire an agent
          </Button>
        )
      ) : canSetupAgents(role) ? (
        <>
          {setupError && (
            <p role="alert" className="m-0 text-body text-error" data-testid="agents-setup-error">
              {setupError}
            </p>
          )}
          <Button type="button" size="sm" disabled={setupPending} onClick={onSetup} data-testid="agents-setup">
            {setupPending ? 'Setting up…' : setupError ? 'Retry' : 'Set up agents'}
          </Button>
        </>
      ) : role ? (
        <p className="m-0 text-body text-muted" data-testid="agents-ask-admin">
          Agents are not set up here yet. Ask a workspace admin to set them up.
        </p>
      ) : null}
    </div>
  );
}
