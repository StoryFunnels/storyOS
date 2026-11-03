import { Button } from '@/components/ui/button';
import { COPY } from '@/lib/runners/words';

/** The design bolds the two tools in the first sentence. */
const BOLD = 'Claude Code or Cursor';

/** "Acme Co, Orbis and Mabon" / "Acme Co, Orbis, Mabon and 4 more". Never more names than the count says exist. */
export function namesLine(names: readonly string[], total: number): string {
  const shown = names.slice(0, 3).slice(0, Math.max(0, total));
  const more = total - shown.length;
  const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')}${more > 0 ? ', ' : ' and '}${shown[shown.length - 1]}`;
  return `${list}${more > 0 ? ` and ${more} more` : ''}.`;
}

/**
 * Ticket #1139 AC1 — the first-time moment on an agent's page when no Runner serves it yet (the prototype's `.firstrun`).
 *
 * `waiting` is the API's own count of records waiting for THIS agent (`agent-wakes/summary`), or null when the summary has not
 * said: then the line is left out rather than guessed (CLAUDE.md "never guess numbers"; a confident 0 is the worst one). There is
 * no "Use an API key instead" button: an API key on StoryOS is not in v1 and is hidden (Dara, ticket #1139).
 */
export function FirstRunCard({
  agentName,
  waiting,
  names = [],
  onAdd,
}: {
  agentName: string;
  waiting: number | null;
  /** Titles of some of the waiting records, when the queue page has them. The COUNT is `waiting`, never `names.length`. */
  names?: readonly string[];
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
      {waiting !== null && waiting > 0 && (
        <p className="m-0 text-body leading-[1.5] text-ink-secondary">
          <b className="font-semibold text-ink">{waiting === 1 ? '1 record is waiting for it' : `${waiting} records are waiting for it`}</b>
          {names.length > 0 ? `: ${namesLine(names, waiting)}` : '.'}
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
