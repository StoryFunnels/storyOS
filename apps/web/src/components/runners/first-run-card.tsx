import { Button } from '@/components/ui/button';
import { recordsWaitingLine } from '@/lib/runners/runner-state';
import { COPY, SUPPORTED_TOOLS } from '@/lib/runners/words';

/** The design bolds the tool in the first sentence. */
const BOLD = SUPPORTED_TOOLS;

/**
 * Ticket #1139 AC1 — the first-time moment on an agent's page when no Runner serves it yet (the prototype's `.firstrun`).
 *
 * `recordsWaiting` is the summary's `catch_up` for THIS agent (records already in its trigger state), or null when it is not
 * known: then the line is left out rather than guessed (CLAUDE.md "never guess numbers"; a confident 0 is the worst one). It is
 * never the queued-wakes count, and no record names are shown: the API gives no list that matches the count (ticket #1223). There is
 * no "Use an API key instead" button: an API key on StoryOS is not in v1 and is hidden (Dara, ticket #1139).
 */
export function FirstRunCard({
  agentName,
  recordsWaiting,
  noun = 'record',
  onAdd,
}: {
  agentName: string;
  recordsWaiting: number | null;
  /** Singular noun of the agent's trigger database ("client"), from the catch-up box's own source; "record" when unknown. */
  noun?: string;
  onAdd: () => void;
}) {
  const [before, after] = COPY.firstRun.split(BOLD);
  return (
    <section
      aria-label={`${agentName} has not started work`}
      data-testid="first-run"
      className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-border-strong bg-card p-4"
    >
      <h3 className="m-0 text-prose font-semibold text-ink">{agentName} hasn’t started work yet</h3>
      <p className="m-0 text-body leading-[1.5] text-ink-secondary">
        {before}
        <b className="font-semibold text-ink">{BOLD}</b>
        {after}
      </p>
      {recordsWaiting !== null && recordsWaiting > 0 && (
        <p className="m-0 text-body leading-[1.5] text-ink-secondary">
          <b className="font-semibold text-ink">{recordsWaitingLine(recordsWaiting, noun)}</b>.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onAdd}>
          Add a Runner
        </Button>
      </div>
    </section>
  );
}
