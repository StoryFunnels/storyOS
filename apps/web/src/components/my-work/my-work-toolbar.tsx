'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownUp, Check, Database, Filter, Layers, X } from 'lucide-react';
import { EntityIcon } from '@/components/ui/icon-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FilterBuilderPanel } from '@/components/views/view-toolbar';
import { buildFilterGroup, filterConditions, filterConnector } from '@/components/views/filter-config';
import type { FilterConnector, FilterNode } from '@/components/views/filter-config';
import { cn } from '@/lib/utils';
import { toField, type MyWorkDbConfig } from './group-config';
import { SORT_LABELS, appliedConditionCount, filterChips, type MyWorkGroup, type MyWorkSortKey } from './my-work-model';

export type MyWorkGrouping = 'none' | 'database';
const GROUPING_LABELS: Record<MyWorkGrouping, string> = { none: 'None', database: 'Database' };

const TOOL_BUTTON =
  'flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border px-2 py-1 text-label font-medium';

/**
 * #968 — ONE toolbar for the merged list: Filter · Sort · Group, plus a chip for every database whose saved filter
 * is narrowing the list. Calm by default, power on demand: the per-database settings are not gone, they are one
 * level down (the Filter panel holds a filter set per database; Group = Database brings the sections and each
 * section's ⋯ holds that database's sort, group-by, colour-by and fields). All of it reads and writes the SAME
 * stored per-database preferences as before; nothing is migrated or deleted.
 */
export function MyWorkToolbar({
  ws,
  groups,
  configs,
  members,
  sort,
  onSort,
  grouping,
  onGrouping,
  onConfigChange,
}: {
  ws: string;
  groups: MyWorkGroup[];
  configs: Record<string, MyWorkDbConfig | undefined>;
  members: Array<{ id: string; name: string }>;
  sort: MyWorkSortKey;
  onSort: (next: MyWorkSortKey) => void;
  grouping: MyWorkGrouping;
  onGrouping: (next: MyWorkGrouping) => void;
  onConfigChange: (dbId: string, config: MyWorkDbConfig) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const chips = filterChips(groups, configs);
  const applied = chips.reduce((n, c) => n + c.count, 0);

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border-default px-4 py-2" data-testid="my-work-toolbar">
      <FilterPopover
        ws={ws}
        open={filterOpen}
        onOpenChange={setFilterOpen}
        groups={groups}
        configs={configs}
        members={members}
        applied={applied}
        onConfigChange={onConfigChange}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(TOOL_BUTTON, 'border-border-default text-muted hover:bg-hover hover:text-ink')}>
            <ArrowDownUp className="h-3.5 w-3.5" /> Sort: {SORT_LABELS[sort]}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {(Object.keys(SORT_LABELS) as MyWorkSortKey[]).map((k) => (
            <DropdownMenuItem key={k} onSelect={() => onSort(k)} className="justify-between">
              {SORT_LABELS[k]}
              {sort === k && <Check className="h-3.5 w-3.5 text-accent" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(TOOL_BUTTON, 'border-border-default text-muted hover:bg-hover hover:text-ink')}>
            <Layers className="h-3.5 w-3.5" /> Group: {GROUPING_LABELS[grouping]}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {(Object.keys(GROUPING_LABELS) as MyWorkGrouping[]).map((g) => (
            <DropdownMenuItem key={g} onSelect={() => onGrouping(g)} className="justify-between">
              {GROUPING_LABELS[g]}
              {grouping === g && <Check className="h-3.5 w-3.5 text-accent" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {chips.map((chip) => (
        <span
          key={chip.dbId}
          data-testid="my-work-filter-chip"
          className="flex items-center rounded-full border border-border-default bg-card text-label text-ink"
        >
          <button type="button" className="rounded-l-full py-0.5 pl-2.5 pr-1.5 hover:bg-hover" onClick={() => setFilterOpen(true)}>
            {chip.label}
          </button>
          <button
            type="button"
            aria-label={`Clear ${chip.label}`}
            className="rounded-r-full py-0.5 pl-0.5 pr-1.5 text-faint hover:bg-hover hover:text-ink"
            onClick={() => onConfigChange(chip.dbId, { ...(configs[chip.dbId] ?? {}), filters: undefined })}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

type Draft = { connector: FilterConnector; nodes: FilterNode[] };

/**
 * The Filter button: one button, one panel, a filter set PER DATABASE. Edits go into a draft and are saved once,
 * when the panel closes (the same rule as a view's own filter, #278): typing a value must not write a preference
 * per keystroke.
 */
function FilterPopover({
  ws,
  open,
  onOpenChange,
  groups,
  configs,
  members,
  applied,
  onConfigChange,
}: {
  ws: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  groups: MyWorkGroup[];
  configs: Record<string, MyWorkDbConfig | undefined>;
  members: Array<{ id: string; name: string }>;
  applied: number;
  onConfigChange: (dbId: string, config: MyWorkDbConfig) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Commit once, on close. Reading the ref keeps this from re-running as the draft changes.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      for (const [dbId, d] of Object.entries(draftsRef.current)) {
        onConfigChange(dbId, { ...(configs[dbId] ?? {}), filters: buildFilterGroup(d.connector, d.nodes) });
      }
      setDrafts({});
    }
    wasOpen.current = open;
  }, [open]);

  const on = applied > 0;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            TOOL_BUTTON,
            on
              ? 'border-[var(--accent)] bg-accent-soft text-ink'
              : 'border-border-default text-muted hover:bg-hover hover:text-ink',
          )}
        >
          <Filter className="h-3.5 w-3.5" /> Filter{on && <span className="tabular-nums">{applied}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[70vh] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto">
        {groups.length === 0 && <p className="p-4 text-body text-muted">Nothing to filter yet.</p>}
        {groups.map((g) => {
          const cfg = configs[g.database.id];
          const d = drafts[g.database.id];
          const connector = d?.connector ?? filterConnector(cfg?.filters);
          const nodes = d?.nodes ?? filterConditions(cfg?.filters);
          const n = appliedConditionCount(buildFilterGroup(connector, nodes));
          return (
            <section key={g.database.id} className="border-b border-border-default last:border-b-0">
              <header className="flex items-center gap-1.5 px-3 pt-3 text-label font-semibold text-ink">
                <EntityIcon icon={g.database.icon} color={g.database.color} fallback={<Database className="h-3.5 w-3.5" />} />
                {g.database.name}
                {n > 0 && <span className="font-normal text-faint">· {n} applied</span>}
              </header>
              <FilterBuilderPanel
                fields={g.fields.map(toField)}
                members={members}
                ws={ws}
                connector={connector}
                nodes={nodes}
                onNodesChange={(next) => setDrafts((p) => ({ ...p, [g.database.id]: { connector, nodes: next } }))}
                onConnectorChange={(next) => setDrafts((p) => ({ ...p, [g.database.id]: { connector: next, nodes } }))}
                onClearAll={() => setDrafts((p) => ({ ...p, [g.database.id]: { connector, nodes: [] } }))}
              />
            </section>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
