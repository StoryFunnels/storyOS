import { Plus } from 'lucide-react';
import { Quill } from '@/components/quill/quill';
import { EmptyState } from '@/components/ui/empty-state';
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
  const quill = <Quill pose="stool" size={88} caption="Nothing to cook yet." captionClassName="max-w-[160px]" />;
  const common = { variant: 'big' as const, quill, title: 'No agents yet', 'data-testid': 'agents-empty' };
  if (hasAgentsDb) {
    return (
      <EmptyState
        {...common}
        action={canHireAgents(role) ? { label: 'Hire an agent', onClick: onHire, icon: <Plus className="h-[13px] w-[13px]" aria-hidden /> } : undefined}
      />
    );
  }
  if (canSetupAgents(role)) {
    return (
      <EmptyState
        {...common}
        body={
          setupError ? (
            <span role="alert" className="text-error" data-testid="agents-setup-error">
              {setupError}
            </span>
          ) : undefined
        }
        action={{
          label: setupPending ? 'Setting up…' : setupError ? 'Retry' : 'Set up agents',
          onClick: onSetup,
          disabled: setupPending,
          testId: 'agents-setup',
        }}
      />
    );
  }
  return (
    <EmptyState
      {...common}
      body={
        role ? (
          <span data-testid="agents-ask-admin">Agents are not set up here yet. Ask a workspace admin to set them up.</span>
        ) : undefined
      }
    />
  );
}
