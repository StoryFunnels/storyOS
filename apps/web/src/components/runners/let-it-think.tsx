import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Ticket #1210 — the line on a Non-AI agent's page. "It runs its steps without an AI." stays as the plain statement; when the
 * viewer is the agent's manager or an admin it carries the one action that moves the agent to Your own AI. `onAct` undefined means
 * the viewer is not offered it (the caller decided with `canLetAgentThink`), so the line is the sentence alone and says "needs no
 * Runner" as before: the old wording is only true for someone who cannot change it.
 */
export function NonAiLine({ onAct, pending = false }: { onAct?: () => void; pending?: boolean }) {
  if (!onAct) {
    return (
      <p className="m-0 text-body text-muted" data-testid="no-runner-needed">
        It runs its steps without an AI, so it needs no Runner.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-body text-muted" data-testid="no-runner-needed">
      <span>It runs its steps without an AI.</span>
      <Button type="button" variant="secondary" size="sm" onClick={onAct} disabled={pending} data-testid="let-it-think">
        {pending ? 'Switching…' : 'Let it think with your AI'}
      </Button>
    </div>
  );
}

/**
 * Ticket #1210 — "Run now": one click makes a manual wake. While a manual wake is already open the button says so and is
 * disabled, so a second click is not possible rather than quietly returning the first Run.
 */
export function RunNowButton({ onRun, pending, alreadyQueued }: { onRun: () => void; pending: boolean; alreadyQueued: boolean }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onRun}
      disabled={pending || alreadyQueued}
      data-testid="run-now"
      title={alreadyQueued ? 'A run you started is already queued or running.' : undefined}
    >
      <Play className="h-[11px] w-[11px]" aria-hidden />
      {pending ? 'Queuing…' : alreadyQueued ? 'Run queued' : 'Run now'}
    </Button>
  );
}
