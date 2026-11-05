import { Button } from '@/components/ui/button';
import { RUNNER_LOAD_FAILED } from '@/lib/runners/runner-state';

/**
 * Ticket #1223 — the "Runs on" line while the page does not yet know which Runner serves the agent: a quiet skeleton while the
 * summary loads (it says nothing, so it cannot say something false), and a plain error with a retry when it failed. Neither is
 * ever the "No Runner yet" state, which is only for a summary that loaded and named no Runner.
 */
export function RunnerUnknownLine({ failed, onRetry, retrying }: { failed: boolean; onRetry: () => void; retrying?: boolean }) {
  if (!failed) {
    return (
      <div className="flex items-center gap-2 text-body text-ink-secondary" data-testid="runs-on-loading" aria-busy="true" aria-label="Loading where this agent runs">
        <span className="h-3.5 w-[220px] max-w-full animate-pulse rounded bg-hover" />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-body" data-testid="runs-on-failed">
      <p role="alert" className="m-0 text-error">
        {RUNNER_LOAD_FAILED}
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
        Retry
      </Button>
    </div>
  );
}
