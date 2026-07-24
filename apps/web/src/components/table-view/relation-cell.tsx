'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { recordHref } from '@/lib/records';
import { Popover, PopoverContent, PopoverParentAnchor } from '@/components/ui/popover';
import type { Field, RecordRow } from './use-table-data';

export interface LinkChip {
  id: string;
  title: string;
  /** Public per-database number for pretty links (MN-087); absent on freshly-picked chips. */
  number?: number | null;
}

/**
 * Apply one relation value to either a record-detail cache entry or an
 * infinite records-list cache. Entity URLs may use a pretty slug while the
 * API row carries a UUID, so callers match the returned row id rather than a
 * React Query key segment.
 */
export function patchRelationProjection(
  old: unknown,
  recordId: string,
  apiName: string,
  chips: LinkChip[],
): unknown {
  if (!old || typeof old !== 'object') return old;

  const record = old as { id?: string; values?: Record<string, unknown> };
  if (record.id === recordId && record.values) {
    return { ...record, values: { ...record.values, [apiName]: chips } };
  }

  const infinite = old as { pages?: Array<{ data?: RecordRow[] }> };
  if (!Array.isArray(infinite.pages)) return old;
  return {
    ...infinite,
    pages: infinite.pages.map((page) => ({
      ...page,
      data: page.data?.map((row) =>
        row.id === recordId
          ? { ...row, values: { ...row.values, [apiName]: chips } }
          : row,
      ),
    })),
  };
}

/** Same hex values as cells.tsx's OPTION_COLORS — kept as a small local copy
 * (mirrors nextOptionColor's comment there) so this leaf module doesn't
 * import from cells.tsx, which already imports RelationChips from here. */
const DB_MARKER_COLORS: Record<string, string> = {
  gray: '#B5B0A5',
  brown: '#8B6F47',
  gold: '#D4A017',
  orange: '#D97E36',
  red: '#C0392B',
  pink: '#C05B7E',
  purple: '#7E5BA6',
  blue: '#3D5296',
  teal: '#057160',
  green: '#2D7A4F',
};

/**
 * Small filled "database" cylinder marker (MN-299): renders in the target
 * database's color immediately before a relation chip's title, so users can
 * tell which database a link points to at a glance — table cells, board
 * cards, the relation editor's own pills, record-detail chips, and
 * related-records panel rows all render this SAME component (never
 * reimplemented per site). Renders nothing if no color is known.
 */
export function DbColorMarker({ color, className }: { color?: string | null; className?: string }) {
  if (!color) return null;
  const hex = DB_MARKER_COLORS[color] ?? DB_MARKER_COLORS.gray!;
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className={cn('shrink-0', className)}>
      <path d="M1 3.2v5.6C1 10 3.2 11 6 11s5-1 5-2.2V3.2" fill={hex} />
      <ellipse cx="6" cy="3.2" rx="5" ry="2.2" fill={hex} />
    </svg>
  );
}

/**
 * Relation-entity chip (#281, "solid mini-tag" direction's outline half): the
 * deliberate visual inverse of OptionChip (cells.tsx) — same 4px-radius shape, but
 * outline-only in a neutral/faint border with normal-case body-size text and no
 * fill or letter-spacing, so a reference to another record (Blocked By, Blocker
 * for, board relation groups, …) is never confused with a category value.
 *
 * #293: when `href` is given, the chip is a real link to the record's own page
 * (new tab — full split-screen is #282's job). Kept optional so call sites that
 * can't yet supply ws/target-database context (e.g. board cards) render exactly
 * as before.
 */
export function RelationChip({
  title,
  href,
  className,
  color,
}: {
  title: string;
  href?: string;
  className?: string;
  /** MN-299: target database color for the cylinder marker. */
  color?: string | null;
}) {
  const shared = cn(
    'inline-flex max-w-40 shrink-0 items-center gap-1 truncate rounded-[var(--radius-chip)] border-[1.4px] border-border-strong px-1.5 py-0.5 text-[13px] text-ink',
    className,
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        // The cell/row this chip sits in usually has its own click handling
        // (select the cell, open the record on row click, …) — stop the click
        // there so opening the chip's own link doesn't also fire that.
        onClick={(e) => e.stopPropagation()}
        className={cn(shared, 'hover:border-border-strong hover:bg-hover hover:underline')}
      >
        <DbColorMarker color={color} />
        <span className="truncate">{title || 'Untitled'}</span>
      </a>
    );
  }
  return (
    <span className={shared}>
      <DbColorMarker color={color} />
      <span className="truncate">{title || 'Untitled'}</span>
    </span>
  );
}

/** Compact relation display (MN-16): cap visible chips so a heavily-linked cell
 * never blows up the row; the rest collapse into a "+N" pill (tooltip lists them). */
export function RelationChips({
  chips,
  max = 3,
  ws,
  targetDb,
  color,
}: {
  chips: LinkChip[];
  max?: number;
  /** #293: workspace + the relation's target database — together with each
   * chip's own {id,title,number} these build the linked record's own-page URL
   * via recordHref (the same helper the record page's own relation display
   * already uses). Omit either to keep chips non-navigable (unchanged). */
  ws?: string;
  targetDb?: string;
  /** MN-299: target database color for each chip's cylinder marker. */
  color?: string | null;
}) {
  const shown = chips.slice(0, max);
  const rest = chips.slice(max);
  return (
    <span className="flex items-center gap-1 overflow-hidden">
      {shown.map((chip) => (
        <RelationChip
          key={chip.id}
          title={chip.title}
          href={ws && targetDb ? recordHref(ws, targetDb, chip) : undefined}
          color={color}
        />
      ))}
      {rest.length > 0 && (
        <span
          className="shrink-0 rounded-[var(--radius-chip)] border border-border-default px-1.5 py-0.5 text-[12px] text-muted"
          title={rest.map((c) => c.title || 'Untitled').join(', ')}
        >
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/**
 * One chip in the picker's "currently selected" row (#293): the title links to
 * the record's own page (new tab), the × removes it. The × is a SIBLING of the
 * link, never nested inside it, so a click on one can't structurally reach the
 * other — `stopPropagation` on both is defense in depth against the cell/row's
 * own click handling underneath the popover, not against each other.
 */
export function SelectedRelationChip({
  chip,
  ws,
  targetDb,
  onRemove,
  color,
}: {
  chip: LinkChip;
  ws: string;
  targetDb: string;
  onRemove: (chip: LinkChip) => void;
  /** MN-299: target database color for the cylinder marker. */
  color?: string | null;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border-default bg-hover px-1.5 py-0.5 text-[12px] text-ink">
      <a
        href={recordHref(ws, targetDb, chip)}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="flex max-w-40 items-center gap-1 truncate hover:underline"
      >
        <DbColorMarker color={color} />
        {chip.title || 'Untitled'}
      </a>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(chip);
        }}
        className="text-faint hover:text-error"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * The record picker (C8): searches the target database by title, links via
 * the links endpoints (PUT replace), supports inline target creation.
 * Single-pick for the many-side of one_to_many, multi otherwise.
 */
export function RelationEditor({
  ws,
  db,
  recordId,
  field,
  current,
  onDone,
  onSaved,
}: {
  ws: string;
  db: string;
  recordId: string;
  field: Field;
  current: LinkChip[];
  onDone: () => void;
  /** Called after the link write succeeds so embedded relation consumers can refresh. */
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const relation = field.relation!;
  const single = relation.cardinality === 'one_to_many' && relation.side === 'a';
  const targetDb = relation.target_database_id;

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LinkChip[]>(current);

  const results = useQuery({
    queryKey: ['record-picker', ws, targetDb, search],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb }, query: { q: search || undefined, limit: 20 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; title: string }> }).data;
    },
  });

  const save = useMutation({
    mutationFn: async ({ ids }: { ids: string[]; chips: LinkChip[] }) => {
      const { error } = await api.PUT(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/links/{field}',
        {
          params: { path: { ws, db, rec: recordId, field: field.id } },
          body: { record_ids: ids },
        },
      );
      if (error) throw error;
    },
    // #293 (investigated, not live-reproducible — see PR description): every
    // OTHER field type's edit (useRecordMutations' updateRecord) patches the
    // records-list cache optimistically in onMutate, so CellDisplay shows the
    // new value the instant the editor closes. This mutation had no such
    // patch — it only invalidated on success, an async refetch the editor's
    // close path (onDone, fired from the mutate() call's own onSuccess) never
    // waited on. That's a real race: the popover can close and hand the cell
    // back to CellDisplay (reading the still-stale records-list cache) before
    // the invalidated refetch resolves. Patching optimistically here removes
    // the race entirely, the same way every other field type already avoids
    // it, regardless of network timing.
    onMutate: async ({ chips }) => {
      const recordsKey = ['records', ws, db];
      const recordKey = ['record', ws, db];
      await qc.cancelQueries({ queryKey: recordsKey });
      await qc.cancelQueries({ queryKey: recordKey });
      const previous = [
        ...qc.getQueriesData({ queryKey: recordsKey }),
        ...qc.getQueriesData({ queryKey: recordKey }),
      ];
      const patch = (old: unknown) =>
        patchRelationProjection(old, recordId, field.apiName, chips);
      qc.setQueriesData({ queryKey: recordsKey }, patch);
      // Patches every detail-key spelling (UUID and pretty slug), which keeps
      // the entity page's pinned/sidebar/top/body projections in lockstep.
      qc.setQueriesData({ queryKey: recordKey }, patch);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      for (const [k, v] of (context?.previous ?? []) as Array<[unknown, unknown]>) {
        qc.setQueryData(k as never, v as never);
      }
      toast.error('Could not update links');
    },
    onSuccess: () => onSaved?.(),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
      void qc.invalidateQueries({ queryKey: ['records', ws, targetDb] });
      void qc.invalidateQueries({ queryKey: ['record', ws, db] });
      // Linking is bidirectional. Any open inverse record or collection in the
      // target database must refetch too, not just the edited source record.
      void qc.invalidateQueries({ queryKey: ['record', ws, targetDb] });
      void qc.invalidateQueries({ queryKey: ['collection', ws] });
      void qc.invalidateQueries({ queryKey: ['activity', ws, db] });
      void qc.invalidateQueries({ queryKey: ['activity', ws, targetDb] });
    },
  });

  const createTarget = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb } },
        body: { values: { name } },
      });
      if (error) throw error;
      return data as unknown as { id: string; title: string };
    },
    onSuccess: (created) => {
      pick({ id: created.id, title: created.title });
      setSearch('');
      void qc.invalidateQueries({ queryKey: ['record-picker', ws, targetDb] });
    },
  });

  function pick(chip: LinkChip) {
    if (single) {
      // Single-pick saves and closes immediately — unchanged.
      save.mutate({ ids: [chip.id], chips: [chip] }, { onSuccess: onDone });
      return;
    }
    // MN-279: multi-select used to only update local state here and wait for
    // Done/Clear/close to persist — an easy-to-miss step that silently drops
    // a toggle if the popover is dismissed another way. Save every toggle
    // right away, same as single-select; the popover stays open (no onDone)
    // so picking multiple items stays fluid.
    const next = selected.some((c) => c.id === chip.id)
      ? selected.filter((c) => c.id !== chip.id)
      : [...selected, chip];
    setSelected(next);
    save.mutate({ ids: next.map((c) => c.id), chips: next });
  }

  // MN-230d: closing (outside click, Escape) resolves the same way the old
  // mousedown-outside handler did — single-pick just cancels back to the
  // last save, multi-pick commits whatever is currently checked (MN-279:
  // in practice a no-op resave since every toggle already persisted, but it
  // still needs to fire onDone to close the popover).
  function handleOpenChange(open: boolean) {
    if (open) return;
    if (single) onDone();
    else save.mutate({ ids: selected.map((c) => c.id), chips: selected }, { onSuccess: onDone });
  }

  const selectedIds = useMemo(() => new Set(selected.map((c) => c.id)), [selected]);
  const rows = results.data ?? [];
  const trimmed = search.trim();
  const exactMatch = rows.some((r) => r.title.toLowerCase() === trimmed.toLowerCase());
  const showCreate = trimmed !== '' && !exactMatch;
  const itemCount = rows.length + (showCreate ? 1 : 0);

  // MN-285: arrow-key highlight across the fetched rows + the "create" row,
  // reset whenever the query (and so the result set) changes.
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [search]);

  function pickIndex(idx: number) {
    if (idx < rows.length) {
      pick(rows[idx]!);
    } else if (showCreate && trimmed) {
      createTarget.mutate(trimmed);
    }
  }

  return (
    <Popover open onOpenChange={handleOpenChange}>
      <PopoverParentAnchor />
      <PopoverContent className="w-72" onClick={(e) => e.stopPropagation()}>
        {!single && selected.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b border-border-default p-2">
            {selected.map((chip) => (
              <SelectedRelationChip
                key={chip.id}
                chip={chip}
                ws={ws}
                targetDb={targetDb}
                onRemove={pick}
                color={relation.target_database_color}
              />
            ))}
          </div>
        )}
        <input
          autoFocus
          placeholder={`Search or create ${relation.target_database_name ?? 'records'}…`}
          className="w-full border-b border-border-default bg-card px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(itemCount - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (itemCount > 0) pickIndex(active);
            }
            e.stopPropagation();
          }}
        />
        <div className="max-h-56 overflow-y-auto p-1">
          {rows.map((row, idx) => (
            <button
              key={row.id}
              className={cn(
                'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover',
                (selectedIds.has(row.id) || idx === active) && 'bg-hover',
              )}
              onMouseEnter={() => setActive(idx)}
              onClick={() => pick(row)}
            >
              <span className="truncate">{row.title || 'Untitled'}</span>
              {/* MN-292: mark the currently linked record(s) — previously only
                  the multi-select case showed anything, so a single-pick
                  relation field's picker never revealed its current value. */}
              {selectedIds.has(row.id) && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
            </button>
          ))}
          {showCreate ? (
            <button
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[13px] text-info hover:bg-hover',
                active === rows.length && 'bg-hover',
              )}
              onMouseEnter={() => setActive(rows.length)}
              onClick={() => createTarget.mutate(trimmed)}
              disabled={createTarget.isPending}
            >
              <Plus className="h-3.5 w-3.5" /> {createTarget.isPending ? 'Creating…' : `Add new “${trimmed}”`}
            </button>
          ) : (
            !trimmed && (
              <p className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-faint">
                <Plus className="h-3.5 w-3.5" /> Type a name to create a new one
              </p>
            )
          )}
        </div>
        <div className="flex justify-between border-t border-border-default px-2 py-1.5">
          <button
            className="text-[12px] text-muted hover:text-ink"
            onClick={() => save.mutate({ ids: [], chips: [] }, { onSuccess: onDone })}
          >
            Clear
          </button>
          {!single && (
            <button
              className="text-[12px] text-ink underline"
              onClick={() =>
                save.mutate({ ids: selected.map((c) => c.id), chips: selected }, { onSuccess: onDone })
              }
            >
              Done
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
