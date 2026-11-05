'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { databaseNoun } from '@/lib/records';
import {
  REUSE_COPY,
  cantUseLine,
  isStalePick,
  noneUsableLine,
  pickedCandidate,
  reuseView,
  type ExistingChoice,
  type ReusePick,
  type ReuseView,
} from '@/lib/pack-review';

/**
 * #1149 / #1156 / #1176 — the choice for ONE database that already exists in ANOTHER space. One component, three shapes, picked by
 * `reuseView` (lib/pack-review.ts) from what the server said:
 *  - one database to consider: two radio cards, "Create a new X here" (the default) and "Use your existing X (in <space>)", the second
 *    disabled with the server's own reason when it cannot be used (#1156, unchanged);
 *  - several, some usable: "Create a new X database here" (the default) and "Use one of your X databases", which opens a short list
 *    of the usable ones, then what the pack adds to the picked one, then one muted line for the ones that cannot be used (#1176);
 *  - several, none usable: one quiet line, no radios. A disabled radio nobody can ever enable is a dead end.
 */
export function ReuseChoice({
  ws,
  choice,
  newSpace,
  pick,
  adds,
  stale,
  onPick,
}: {
  ws: string;
  choice: ExistingChoice;
  /** The space the new database would land in — "Empty, in <this>". */
  newSpace: string;
  /** What the person chose; undefined is the default (create new). */
  pick: ReusePick | undefined;
  /** One-candidate row: fields the install would add to the existing database (from the what-if preview); undefined while unknown. */
  adds: string[] | undefined;
  /** The pick was dropped because the server no longer stands behind it (confirming preview said no): say so, once. */
  stale: boolean;
  onPick: (pick: ReusePick) => void;
}) {
  const view = reuseView(choice.hint);
  if (view.kind === 'none') return <ReuseNone name={choice.name} view={view} />;
  if (view.kind === 'many')
    return <ReuseManyView name={choice.name} newSpace={newSpace} view={view} pick={pick} stale={stale || isStalePick(view, pick)} onPick={onPick} />;
  return <ReuseSingle ws={ws} choice={{ name: choice.name, hint: view.hint }} newSpace={newSpace} selected={pick?.use === true} adds={adds} onSelect={(use) => onPick({ use })} />;
}

const radioCard = (on: boolean, disabled: boolean) =>
  cn(
    'flex items-start gap-2 rounded-[var(--radius-control)] border px-2.5 py-2',
    on ? 'border-primary shadow-[inset_0_0_0_1px_var(--primary)]' : 'border-border-default',
    disabled ? 'cursor-default opacity-75' : 'cursor-pointer',
  );

/** #1176 — several exist and none can be used: one quiet line (Dara), where the disabled radio used to be. */
export function ReuseNone({ name, view }: { name: string; view: Extract<ReuseView, { kind: 'none' }> }) {
  return (
    <p className="mt-1.5 text-label leading-[1.55] text-ink-secondary" data-testid="pack-reuse-none" data-database={name}>
      {noneUsableLine(name, view.unusable)}
    </p>
  );
}

/**
 * #1176 — pure (no hooks, so a test renders it): the row for several same-named databases. The list holds only usable candidates, so a
 * candidate the server refused is never a radio; it is named in the muted line under the list instead.
 */
export function ReuseManyView({
  name,
  newSpace,
  view,
  pick,
  stale,
  onPick,
}: {
  name: string;
  newSpace: string;
  view: Extract<ReuseView, { kind: 'many' }>;
  pick: ReusePick | undefined;
  stale: boolean;
  onPick: (pick: ReusePick) => void;
}) {
  const chosen = pickedCandidate(view, pick);
  const using = chosen !== null;
  const cant = cantUseLine(view.unusable);
  const first = view.usable[0]!;
  return (
    <span className="mt-1 flex flex-col" data-testid="pack-reuse-choice" data-database={name} data-kind="many">
      <em className="mb-1.5 text-label not-italic text-ink-secondary">{REUSE_COPY.headingMany(name, view.total)}</em>
      <span role="radiogroup" aria-label={name} className="flex flex-col gap-1.5">
        <label className={radioCard(!using, false)}>
          <input type="radio" name={`reuse-${name}`} className="mt-[3px] shrink-0" checked={!using} onChange={() => onPick({ use: false })} />
          <span className="flex min-w-0 flex-col">
            <b className="text-body font-semibold text-ink">{REUSE_COPY.createManyTitle(name)}</b>
            <small className="text-label leading-[1.45] text-muted">{REUSE_COPY.createSub(newSpace)}</small>
          </span>
        </label>
        <label className={radioCard(using, false)}>
          <input
            type="radio"
            name={`reuse-${name}`}
            className="mt-[3px] shrink-0"
            checked={using}
            onChange={() => onPick({ use: true, databaseId: first.database_id })}
          />
          <span className="flex min-w-0 flex-col">
            <b className="text-body font-semibold text-ink">{REUSE_COPY.useManyTitle(name)}</b>
            <small className="text-label leading-[1.45] text-muted">{REUSE_COPY.useManySub(view.usable.length, first.space_name)}</small>
          </span>
        </label>
      </span>
      {stale && (
        <p role="status" className="mt-1.5 text-label leading-[1.45] text-ink-secondary" data-testid="pack-reuse-stale">
          {REUSE_COPY.stalePick(name)}
        </p>
      )}
      {using && (
        <>
          <span
            role="radiogroup"
            aria-label={`Which ${name}`}
            className="ml-6 mt-1.5 flex flex-col overflow-hidden rounded-[var(--radius-control)] border border-border-default bg-card"
            data-testid="pack-reuse-pick"
          >
            {view.usable.map((c, i) => {
              const on = c.database_id === chosen.database_id;
              const label = REUSE_COPY.pickLabel(name, c);
              return (
                <label key={c.database_id} className={cn('flex cursor-pointer items-start gap-2 px-2.5 py-[7px] text-label leading-[1.4]', i > 0 && 'border-t border-border-default', on && 'bg-active')}>
                  <input
                    type="radio"
                    name={`reusepick-${name}`}
                    className="mt-[3px] shrink-0"
                    checked={on}
                    value={c.database_id}
                    onChange={() => onPick({ use: true, databaseId: c.database_id })}
                  />
                  <span className="min-w-0 text-label text-ink">
                    <b className="font-semibold">{label.main}</b>
                    {label.count && <span className="text-muted"> {label.count}</span>}
                  </span>
                </label>
              );
            })}
          </span>
          <p className="mt-0.5 text-label leading-[1.55] text-ink-secondary" data-testid="pack-reuse-adds">
            {REUSE_COPY.pickedAdds({ noun: databaseNoun(name), space: chosen.space_name, added: chosen.fields_added?.map((f) => f.name) })}
          </p>
        </>
      )}
      {cant && (
        <p className="mt-2 text-label leading-[1.55] text-ink-secondary" data-testid="pack-reuse-cant">
          {cant}
        </p>
      )}
    </span>
  );
}

/** #1156 — one database to consider. Unchanged by #1176 apart from the article in its heading and taking the pick as a plain boolean. */
function ReuseSingle({
  ws,
  choice,
  newSpace,
  selected,
  adds,
  onSelect,
}: {
  ws: string;
  choice: ExistingChoice;
  newSpace: string;
  selected: boolean;
  adds: string[] | undefined;
  onSelect: (useExisting: boolean) => void;
}) {
  const { name, hint } = choice;
  const usable = hint.reusable;
  const its = hint.space_name ?? 'that space';
  // A live number on this open of the review, never cached (Dara): zero staleness, and dropped when the row goes away.
  const count = useQuery({
    queryKey: ['pack-reuse-count', ws, hint.database_id],
    enabled: usable && Boolean(hint.database_id),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/aggregate', {
        params: { path: { ws, db: hint.database_id! } },
        body: { op: 'count' } as never,
      });
      if (error) throw error;
      return (data as unknown as { value: number | null }).value ?? 0;
    },
  });
  const useSelected = usable && selected;
  const group = `reuse-${name}`;
  return (
    <span className="mt-1 flex flex-col gap-1.5" data-testid="pack-reuse-choice" data-database={name} data-kind="single">
      <em className="text-label not-italic text-ink-secondary">{REUSE_COPY.heading(name)}</em>
      <span role="radiogroup" aria-label={`${name}: create a new one or use your existing one`} className="flex flex-col gap-1.5">
        <label className={radioCard(!useSelected, false)}>
          <input type="radio" name={group} className="mt-[3px] shrink-0" checked={!useSelected} onChange={() => onSelect(false)} />
          <span className="flex min-w-0 flex-col">
            <b className="text-body font-semibold text-ink">{REUSE_COPY.createTitle(name)}</b>
            <small className="text-label leading-[1.45] text-muted">{REUSE_COPY.createSub(newSpace)}</small>
          </span>
        </label>
        <label className={radioCard(useSelected, !usable)}>
          <input type="radio" name={group} className="mt-[3px] shrink-0" checked={useSelected} disabled={!usable} onChange={() => onSelect(true)} />
          <span className="flex min-w-0 flex-col">
            <b className="text-body font-semibold text-ink">{REUSE_COPY.useTitle(name, hint.space_name)}</b>
            <small className={cn('text-label leading-[1.45]', usable ? 'text-muted' : 'text-ink-secondary')}>
              {usable
                ? REUSE_COPY.existingSub({
                    noun: databaseNoun(name),
                    count: count.data ?? null,
                    space: newSpace,
                    its,
                    adds: adds ?? null,
                  })
                : (hint.reason ?? 'This one can’t be used.')}
            </small>
          </span>
        </label>
      </span>
    </span>
  );
}
