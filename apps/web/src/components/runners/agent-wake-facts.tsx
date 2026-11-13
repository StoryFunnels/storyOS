import type { ReactNode } from 'react';
import Link from 'next/link';
import { NO_TRIGGER_LINE, WAKE_RULES_NOTE, isEmptyWorksIn, spaceNote, unresolvedLine, wakeChip, withheldLine, worksInFact } from '@/lib/runners/wake-facts';
import type { AgentScopeDto, WakeLine } from '@/lib/runners/wake-facts';
import type { FactsState } from '@/lib/runners/use-agent-facts';

/**
 * Ticket #1289 — the two rows the agent page's facts box was missing: what wakes the agent and where it works. Each is the VALUE of
 * a row in the shared facts box (the page draws the label), read-only: the words come from `lib/runners/wake-facts.ts`.
 *
 * Gold is not used: nothing here is an agent acting. A trigger that is Off carries the muted "Off" mark, never colour alone.
 */
const MARK = 'ml-1.5 rounded-[4px] border border-border-default px-1.5 text-label text-muted';

function Pending({ failed }: { failed: boolean }) {
  return <span className="text-muted">{failed ? 'Could not read this just now.' : 'Loading…'}</span>;
}

export function WakesWhenValue({ state, ws, linkDatabaseId }: { state: FactsState<WakeLine[]>; ws: string; linkDatabaseId: string | null }) {
  if (state.status !== 'ready') return <Pending failed={state.status === 'failed'} />;
  const lines = state.value;
  return (
    <div data-testid="agent-wakes-when">
      {lines.length === 0 ? (
        <div className="text-muted">{NO_TRIGGER_LINE}</div>
      ) : (
        lines.map((l) => {
          const chip = wakeChip(l);
          return (
            <div key={l.key} data-testid="wake-line" data-state={l.state} className={l.state === 'off' ? 'text-muted' : 'text-ink'}>
              {l.databaseId ? (
                <Link className="text-inherit no-underline hover:underline" href={`/w/${ws}/d/${l.databaseId}`}>
                  {l.text}
                </Link>
              ) : (
                l.text
              )}
              {chip && <span className={MARK}>{chip}</span>}
            </div>
          );
        })
      )}
      <div className="mt-0.5 text-label text-muted" data-testid="wake-rules-note">
        {WAKE_RULES_NOTE.before}
        {linkDatabaseId ? (
          <Link className="font-medium text-primary-text underline" href={`/w/${ws}/d/${linkDatabaseId}`}>
            {WAKE_RULES_NOTE.link}
          </Link>
        ) : (
          WAKE_RULES_NOTE.link
        )}
        {WAKE_RULES_NOTE.after}
      </div>
    </div>
  );
}

/** `databases` is the workspace's database list (undefined while loading): the scope alone cannot say which are system databases. */
export function WorksInValue({ state, ws, databases }: { state: FactsState<AgentScopeDto>; ws: string; databases: ReadonlyArray<{ id: string; isSystem?: boolean }> | undefined }) {
  if (state.status !== 'ready') return <Pending failed={state.status === 'failed'} />;
  if (!databases) return <Pending failed={false} />;
  const f = worksInFact(state.value, databases);
  if (isEmptyWorksIn(f)) return <span className="text-muted">No database chosen.</span>;
  const unresolved = unresolvedLine(f.unresolved);
  const withheld = withheldLine(f.withheld);
  const named: ReactNode[] = [
    ...f.spaces.map((s) => (
      <span key={`s-${s.id}`}>
        <b>{s.name}</b> · whole space
      </span>
    )),
    ...f.databases.map((d) => (
      <Link key={`d-${d.id}`} className="text-inherit no-underline hover:underline" href={`/w/${ws}/d/${d.id}`}>
        {d.name}
      </Link>
    )),
  ];
  return (
    <div data-testid="agent-works-in">
      {named.length > 0 && (
        <div>
          {named.map((n, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {n}
            </span>
          ))}
        </div>
      )}
      {f.spaces.map((s) => (
        <div key={`n-${s.id}`} className="text-label text-muted">
          {spaceNote(s)}
        </div>
      ))}
      {unresolved && <div className="text-label text-muted">{unresolved}</div>}
      {withheld && <div className="text-label text-muted">{withheld}</div>}
    </div>
  );
}
