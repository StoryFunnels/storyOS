'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Plus, Search, Star } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useDatabases } from '@/lib/queries';
import { VIEW_ICON } from './view-tab';
import type { ViewSummary } from './use-view-state';
import { switcherGroups, viewSources } from './pinned-tabs';

/**
 * #966 — the one switcher that holds every shared view, so the tab strip can stay at the 2–3 you pinned.
 * "<view> · N views" opens a searchable list in two groups (Pinned, All views). Each row NAMES ITS SOURCES
 * ("Health Board · Clients"): colour alone does not say what a view reads. The pin star rests at --faint and is a
 * real button on every row, so nothing waits for a hover (#900); the + New view foot opens the existing dialog,
 * which already shows all nine types with their "Needs …" reasons.
 *
 * Personal views are not here: they stay in the sidebar's Personal section.
 */
export function ViewSwitcher({
  ws,
  db,
  databaseName,
  views,
  activeId,
  pinnedIds,
  canCreate,
  onNavigate,
  onSetPinned,
  onNewView,
}: {
  ws: string;
  db: string;
  databaseName: string;
  views: ViewSummary[];
  activeId: string | undefined;
  pinnedIds: string[];
  canCreate: boolean;
  onNavigate: (viewId: string) => void;
  onSetPinned: (viewId: string, wanted: boolean) => void;
  onNewView: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Only a dashboard names a database other than this one, so the list is fetched on first open, not on page load.
  const databases = useDatabases(ws, open);
  const nameOf = (id: string) => databases.data?.find((d) => d.id === id)?.name;
  const sourcesOf = (v: ViewSummary) => viewSources(v, databaseName, db, nameOf);

  const shared = useMemo(() => views.filter((v) => !v.ownerUserId), [views]);
  const groups = useMemo(
    () => switcherGroups(views, pinnedIds, query, sourcesOf),
    [views, pinnedIds, query, databases.data],
  );
  const active = shared.find((v) => v.id === activeId);

  const row = (view: ViewSummary, group: string) => {
    const Icon = VIEW_ICON[view.type];
    const pinned = pinnedIds.includes(view.id);
    return (
      <div
        key={`${group}:${view.id}`}
        className={cn(
          'flex items-center gap-1 rounded-[var(--radius-chip)] pr-1 hover:bg-hover',
          view.id === activeId && 'bg-active',
        )}
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onNavigate(view.id);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block truncate text-body text-ink">{view.name}</span>
            <span className="block truncate text-label text-muted">
              {sourcesOf(view).join(' · ')}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => onSetPinned(view.id, !pinned)}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${view.name} from tabs` : `Pin ${view.name} to tabs`}
          title={pinned ? 'Unpin from tabs' : 'Pin to tabs'}
          className={cn(
            'shrink-0 rounded p-1.5 hover:bg-active hover:text-ink',
            pinned ? 'text-primary-text' : 'text-faint',
          )}
        >
          <Star className={cn('h-3.5 w-3.5', pinned && 'fill-current')} />
        </button>
      </div>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Switch view"
          // #994 — the prototype's `.switcher`: a bordered control, chevron first, the view's name bold, then the count.
          className="flex h-[27px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 text-label text-muted hover:border-border-strong hover:text-ink"
        >
          <ChevronDown className="h-3 w-3" />
          <b className="max-w-[6rem] truncate font-[650] text-ink sm:max-w-[10rem]">{active?.name ?? 'Views'}</b>
          {/* #996 — the count hides with the TOOLBAR's own width (a container query), not the viewport's: the toolbar sits
              in a column that is narrower than the window whenever a record peek is open. */}
          <span className="whitespace-nowrap @max-[520px]:hidden">
            · {shared.length} view{shared.length === 1 ? '' : 's'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-1">
        <div className="relative px-1 pb-1 pt-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-[40%] text-faint" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a view…"
            aria-label="Find a view"
            size="sm"
            className="w-full pl-7"
          />
        </div>
        <div className="max-h-80 overflow-y-auto">
          {groups.pinned.length > 0 && (
            <>
              <span className="block px-2 pb-0.5 pt-1.5 text-meta font-semibold uppercase tracking-wider text-muted">
                Pinned
              </span>
              {groups.pinned.map((v) => row(v, 'pinned'))}
            </>
          )}
          <span className="block px-2 pb-0.5 pt-1.5 text-meta font-semibold uppercase tracking-wider text-muted">
            All views
          </span>
          {groups.all.map((v) => row(v, 'all'))}
          {groups.all.length === 0 && (
            <p className="px-2 py-2 text-label text-faint">No view matches.</p>
          )}
        </div>
        {canCreate && (
          <div className="mt-1 border-t border-border-default pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onNewView();
              }}
              className="flex w-full items-center gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 text-left text-body text-ink hover:bg-hover"
            >
              <Plus className="h-3.5 w-3.5 text-muted" /> New view
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
