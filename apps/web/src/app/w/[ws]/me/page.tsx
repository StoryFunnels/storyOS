'use client';

import Link from 'next/link';
import { isTypingTarget } from '@/lib/shortcuts';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { EntityIcon } from '@/components/ui/icon-picker';
import { useMembers } from '@/components/table-view/use-table-data';
import {
  type DenseField,
  type MyWorkDbConfig,
  EMPTY_MYWORK,
  GroupHeader,
  groupRecords,
  sortMyWorkRecords,
} from '@/components/my-work/group-config';
import { MyWorkToolbar, type MyWorkGrouping } from '@/components/my-work/my-work-toolbar';
import { MyWorkPreview, MyWorkRowButton, SectionHeader, rowKey } from '@/components/my-work/my-work-rows';
import {
  buildRows,
  sortRows,
  type MyWorkGroup,
  type MyWorkRow,
  type MyWorkSortKey,
} from '@/components/my-work/my-work-model';
import { PullRequestsPanel } from '@/components/reviews/pull-requests-panel';
import { ListSurface } from '@/components/entity/split-screen-host';
import { useDateFormat } from '@/lib/preferences';
import { cn } from '@/lib/utils';
import { databaseColor } from '@/lib/entity-color';

interface RecentRecord {
  id: string;
  title: string;
  database_id: string;
  database_name: string;
  database_icon: string | null;
  /** The owning database's stored colour (the recents endpoint returns it); without it the glyph fell back to the default and could differ from the sidebar's. */
  database_color?: string | null;
}

type Tab = 'assigned' | 'created' | 'activity' | 'pull-requests';
const BASE_TABS: { id: Tab; label: string }[] = [
  { id: 'assigned', label: 'Assigned' },
  { id: 'created', label: 'Created' },
  { id: 'activity', label: 'Activity' },
];
const PULL_REQUESTS_TAB = { id: 'pull-requests' as Tab, label: 'Pull requests' };

/** The two view choices that are NOT per-database (the per-database ones live in `preferences.myWork`). Per browser, per workspace. */
interface ViewChoice {
  grouping: MyWorkGrouping;
  sort: MyWorkSortKey;
}
const DEFAULT_CHOICE: ViewChoice = { grouping: 'none', sort: 'due' };
const choiceKey = (ws: string) => `storyos-mywork-view:${ws}`;
function readChoice(ws: string): ViewChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(choiceKey(ws)) ?? 'null') as Partial<ViewChoice> | null;
    return {
      grouping: raw?.grouping === 'database' ? 'database' : 'none',
      sort: raw?.sort === 'updated' || raw?.sort === 'title' ? raw.sort : 'due',
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

/**
 * My Work (MN-049, #36), Inbox-shaped (#968): one list sorted by due date on the left, a preview of the selected
 * row on the right; under md the preview REPLACES the list, with "← My Work". Tabs: Assigned · Created · Activity,
 * and Pull requests when GitHub is connected. One toolbar (Filter · Sort · Group) holds everything the per-database
 * toolbars used to: Group = Database brings the old per-database sections back, each with its own ⋯.
 *
 * It is mounted inside `ListSurface` so a record opened from elsewhere can still dock beside it; ↑/↓ walk the
 * rows you can see and move the preview, with no navigation and no lost place.
 */
export default function MyWorkPage() {
  return (
    <ListSurface label="My Work">
      <Suspense fallback={null}>
        <MyWorkInner />
      </Suspense>
    </ListSurface>
  );
}

function MyWorkInner() {
  const { ws } = useParams<{ ws: string }>();
  const searchParams = useSearchParams();
  const fmt = useDateFormat();
  const qc = useQueryClient();
  const [now] = useState(() => new Date());

  // Pull requests exists only when GitHub is connected (the directory is readable by any member).
  const integrations = useQuery({
    queryKey: ['integrations-directory', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations', { params: { path: { ws } } } as never);
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; connected: boolean }> }).data;
    },
  });
  const githubConnected = integrations.data?.find((i) => i.id === 'github')?.connected === true;
  const tabs = githubConnected ? [...BASE_TABS, PULL_REQUESTS_TAB] : BASE_TABS;
  const requested = searchParams.get('tab');
  const [pickedTab, setTab] = useState<Tab | null>(null);
  // The URL's ?tab= opens a tab on arrival (the old /reviews redirect); a tab that does not exist falls back to Assigned.
  const wanted = (pickedTab ?? requested ?? 'assigned') as Tab;
  const tab: Tab = tabs.some((t) => t.id === wanted) ? wanted : 'assigned';

  const [choice, setChoice] = useState<ViewChoice>(DEFAULT_CHOICE);
  useEffect(() => setChoice(readChoice(ws)), [ws]);
  const updateChoice = (patch: Partial<ViewChoice>) =>
    setChoice((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(choiceKey(ws), JSON.stringify(next));
      } catch {
        /* storage unavailable: the choice just lasts this visit */
      }
      return next;
    });

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const members = useMembers(ws, true);
  const memberNames = useMemo(() => new Map((members.data ?? []).map((m) => [m.user.id, m.user.name])), [members.data]);
  const memberImages = useMemo(() => new Map((members.data ?? []).map((m) => [m.user.id, m.user.image])), [members.data]);
  const memberList = useMemo(() => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name })), [members.data]);

  // Per-database My Work config, persisted in user preferences (MN-072 part 2). Read AND written exactly as before.
  const prefs = useQuery({
    queryKey: ['preferences'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/users/me/preferences');
      if (error) throw error;
      return data as unknown as { myWork?: Record<string, MyWorkDbConfig> };
    },
  });
  const myWork = prefs.data?.myWork ?? {};
  const saveConfig = useMutation({
    mutationFn: async ({ dbId, config }: { dbId: string; config: MyWorkDbConfig }) => {
      const { error } = await api.PATCH('/api/v1/users/me/preferences', { body: { myWork: { [dbId]: config } } as never });
      if (error) throw error;
    },
    onMutate: ({ dbId, config }) => {
      qc.setQueryData(['preferences'], (old: { myWork?: Record<string, MyWorkDbConfig> } | undefined) => ({
        ...(old ?? {}),
        myWork: { ...(old?.myWork ?? {}), [dbId]: config },
      }));
    },
    onError: () => void qc.invalidateQueries({ queryKey: ['preferences'] }),
  });
  const onConfigChange = (dbId: string, config: MyWorkDbConfig) => saveConfig.mutate({ dbId, config });

  const listTab = tab === 'assigned' || tab === 'created';
  const grouped = useQuery({
    queryKey: ['my-work', ws, tab],
    enabled: listTab,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/my-work', {
        params: { path: { ws }, query: { tab } },
      } as never);
      if (error) throw error;
      return data as unknown as { groups: MyWorkGroup[] };
    },
  });
  const activity = useQuery({
    queryKey: ['my-work-activity', ws],
    enabled: tab === 'activity',
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/recent', { params: { path: { ws } } } as never);
      if (error) throw error;
      return data as unknown as { records: RecentRecord[] };
    },
  });

  const groups = useMemo(() => grouped.data?.groups ?? [], [grouped.data]);
  const recent = activity.data?.records ?? [];

  // filter → sort → (group) ONCE, and read the rendered structure and the flat ↑/↓ order out of that single
  // result: deriving the order separately would be a second ordering implementation, free to drift from the screen.
  const view = useMemo(() => {
    const rows = buildRows(groups, myWork);
    if (choice.grouping === 'none') {
      const merged = sortRows(rows, choice.sort);
      return { merged, sections: [] as Section[], queue: merged };
    }
    const sections: Section[] = groups.map((group) => {
      const config = myWork[group.database.id] ?? EMPTY_MYWORK;
      const fields = group.fields as DenseField[];
      const own = rows.filter((r) => r.dbId === group.database.id);
      const byRecord = new Map(own.map((r) => [r.record.id, r]));
      // This database's own saved sort wins inside its section (it is what the section showed before); otherwise the toolbar's.
      const ordered = config.sorts?.length
        ? sortMyWorkRecords(own.map((r) => r.record), fields, config)
        : sortRows(own, choice.sort).map((r) => r.record);
      const subGroups = groupRecords(ordered, fields, config, memberNames).map((sg) => ({
        ...sg,
        rows: sg.records.map((rec) => byRecord.get(rec.id)!),
      }));
      return { group, config, fields, count: own.length, subGroups };
    });
    const queue: MyWorkRow[] = [];
    for (const s of sections) {
      if (collapsed.has(s.group.database.id)) continue;
      for (const sg of s.subGroups) queue.push(...sg.rows);
    }
    return { merged: [] as MyWorkRow[], sections, queue };
  }, [groups, myWork, choice, memberNames, collapsed]);

  const activeRow = selectedKey ? view.queue.find((r) => rowKey(r) === selectedKey) ?? null : null;
  // Desktop previews the first row so the right pane is never empty; under md the list shows until a row is tapped.
  const previewRow = activeRow ?? view.queue[0] ?? null;
  const showDetail = activeRow !== null;
  const selectionOf = (row: MyWorkRow): 'explicit' | 'implicit' | false =>
    previewRow && rowKey(previewRow) === rowKey(row) ? (activeRow ? 'explicit' : 'implicit') : false;

  // ↑/↓ walk the rows you can see. Desktop only (under md there is one pane), and never while typing.
  const move = useCallback(
    (delta: number) => {
      const i = previewRow ? view.queue.findIndex((r) => rowKey(r) === rowKey(previewRow)) : -1;
      const next = view.queue[i + delta];
      if (next) setSelectedKey(rowKey(next));
    },
    [view.queue, previewRow],
  );
  useEffect(() => {
    if (!listTab) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!window.matchMedia('(min-width: 768px)').matches) return;
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listTab, move]);
  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  const loading = tab === 'activity' ? activity.isLoading : listTab ? grouped.isLoading : false;
  const noItems = !loading && listTab && groups.length === 0;
  const fmtDate = (iso: string) => fmt.date(iso);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-default px-4">
        <UserRound className="h-4 w-4 shrink-0 text-muted" />
        <h1 className="shrink-0 text-sm font-semibold text-ink">My Work</h1>
        <div className="ml-4 flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setSelectedKey(null);
              }}
              className={cn(
                'shrink-0 rounded px-2.5 py-1 text-label font-medium',
                tab === t.id ? 'bg-active text-ink' : 'text-muted hover:bg-hover',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {tab === 'pull-requests' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PullRequestsPanel ws={ws} />
        </div>
      )}

      {tab === 'activity' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && <p className="p-6 text-body text-muted">Loading…</p>}
          {!loading && recent.length === 0 && <p className="p-6 text-body text-muted">No recent activity yet.</p>}
          <div className="mx-auto max-w-3xl">
            {recent.map((r) => (
              <Link
                key={r.id}
                href={`/w/${ws}/d/${r.database_id}/r/${r.id}`}
                className="flex items-start gap-2.5 border-b border-border-default px-4 py-3 hover:bg-hover"
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  <EntityIcon icon={r.database_icon} color={databaseColor(r.database_color, r.database_id)} fallback={<Database className="h-3.5 w-3.5" />} />
                </span>
                <span className="min-w-0 flex-1">
                  <span data-mw-title className="block truncate text-body font-medium text-ink">{r.title || 'Untitled'}</span>
                  <span className="block truncate text-label text-muted">{r.database_name}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {listTab && (
        <>
          <p className="px-4 pt-2 text-label text-muted">Everything with your name on it, across databases.</p>
          {!noItems && !loading && (
            <MyWorkToolbar
              ws={ws}
              groups={groups}
              configs={myWork}
              members={memberList}
              sort={choice.sort}
              onSort={(sort) => updateChoice({ sort })}
              grouping={choice.grouping}
              onGrouping={(grouping) => updateChoice({ grouping })}
              onConfigChange={onConfigChange}
            />
          )}
          <div className="flex min-h-0 flex-1">
            <div
              className={cn(
                'w-full overflow-y-auto border-r border-border-default md:w-[26rem] md:max-w-[26rem] md:shrink-0',
                showDetail && 'hidden md:block',
              )}
            >
              {loading && <p className="p-6 text-body text-muted">Loading…</p>}
              {noItems && (
                <p className="p-6 text-center text-body text-muted">
                  {tab === 'assigned'
                    ? 'Nothing assigned to you yet. When someone sets you in a Person field, it shows up here.'
                    : "You haven't created any items yet."}
                </p>
              )}
              {!loading && !noItems && view.queue.length === 0 && choice.grouping === 'none' && (
                <p className="p-6 text-center text-body text-muted">Your saved filters hide everything. Clear one above to bring items back.</p>
              )}

              {choice.grouping === 'none' &&
                view.merged.map((row) => (
                  <MyWorkRowButton
                    key={rowKey(row)}
                    row={row}
                    selected={selectionOf(row)}
                    onSelect={() => setSelectedKey(rowKey(row))}
                    fmtDate={fmtDate}
                    now={now}
                  />
                ))}

              {choice.grouping === 'database' &&
                view.sections.map(({ group, config, fields, count, subGroups }) => {
                  const isCollapsed = collapsed.has(group.database.id);
                  return (
                    <div key={group.database.id}>
                      <SectionHeader
                        ws={ws}
                        database={group.database}
                        count={count}
                        collapsed={isCollapsed}
                        onToggle={() =>
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.database.id)) next.delete(group.database.id);
                            else next.add(group.database.id);
                            return next;
                          })
                        }
                        fields={fields}
                        config={config}
                        members={memberList}
                        onChange={(next) => onConfigChange(group.database.id, next)}
                      />
                      {!isCollapsed &&
                        subGroups.map((sg) => (
                          <div key={sg.key}>
                            {sg.key !== '_all' && <GroupHeader label={sg.label} color={sg.color} count={sg.records.length} />}
                            {sg.rows.map((row) => (
                              <MyWorkRowButton
                                key={rowKey(row)}
                                row={row}
                                selected={selectionOf(row)}
                                onSelect={() => setSelectedKey(rowKey(row))}
                                fmtDate={fmtDate}
                                now={now}
                              />
                            ))}
                          </div>
                        ))}
                    </div>
                  );
                })}
            </div>

            <div className={cn('min-w-0 flex-1 overflow-y-auto p-4 sm:p-6', !showDetail && 'hidden md:block')}>
              {previewRow ? (
                <MyWorkPreview
                  ws={ws}
                  row={previewRow}
                  tab={tab === 'created' ? 'created' : 'assigned'}
                  onBack={() => setSelectedKey(null)}
                  fmtDate={fmtDate}
                  now={now}
                  memberNames={memberNames}
                  memberImages={memberImages}
                />
              ) : (
                !loading && <p className="text-body text-muted">Select an item to preview it.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface Section {
  group: MyWorkGroup;
  config: MyWorkDbConfig;
  fields: DenseField[];
  count: number;
  subGroups: Array<{ key: string; label: string; color: string | null; records: MyWorkGroup['records']; rows: MyWorkRow[] }>;
}
