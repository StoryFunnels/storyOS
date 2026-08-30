'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Database } from 'lucide-react';
import { api } from '@/lib/api';
import { EntityIcon } from '@/components/ui/icon-picker';
import { CellDisplay } from '@/components/table-view/cells';
import { useMembers } from '@/components/table-view/use-table-data';
import {
  type DenseField,
  type MyWorkDbConfig,
  EMPTY_MYWORK,
  GroupHeader,
  MyWorkGroupToolbar,
  groupRecords,
  matchesFilters,
  rowColor,
  sortMyWorkRecords,
  toField,
  visibleFields,
} from '@/components/my-work/group-config';
import { ListSurface } from '@/components/entity/split-screen-host';
import { useOpenRecord, useSplitPanel } from '@/components/entity/split-panel-context';
import { recordSegment } from '@/lib/records';
import { useDateFormat } from '@/lib/preferences';
import { cn } from '@/lib/utils';

interface MyWorkRecord {
  id: string;
  title: string;
  number: number | null;
  updated_at: string;
  values: Record<string, unknown>;
}
interface MyWorkGroup {
  database: { id: string; name: string; icon: string | null; color: string | null };
  fields: DenseField[];
  records: MyWorkRecord[];
}

interface RecentRecord {
  id: string;
  title: string;
  database_id: string;
  database_name: string;
  database_icon: string | null;
}

type Tab = 'assigned' | 'created' | 'activity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'assigned', label: 'Assigned' },
  { id: 'created', label: 'Created' },
  { id: 'activity', label: 'Activity' },
];

/** My Work / My Issues (MN-049, #36): tabs for what's assigned to me, what I created,
 * and what I recently touched — the cross-database "what should I work on" home.
 *
 * #199 — My Work is the ticket's headline surface: a triage queue. It is mounted
 * inside `ListSurface`, so opening a row puts the record in the split panel BESIDE
 * the queue instead of replacing it, and ↑/↓ walk the queue swapping the panel's
 * record. That is the whole user story: read an item, set its state, move to the
 * next one without losing your place. */
export default function MyWorkPage() {
  return (
    <ListSurface label="My Work">
      <MyWorkInner />
    </ListSurface>
  );
}

function MyWorkInner() {
  const { ws } = useParams<{ ws: string }>();
  const fmt = useDateFormat();
  const [tab, setTab] = useState<Tab>('assigned');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const qc = useQueryClient();
  const members = useMembers(ws, true);
  const memberNames = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.user.id, m.user.name])),
    [members.data],
  );
  const memberImages = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.user.id, m.user.image])),
    [members.data],
  );
  const memberList = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name })),
    [members.data],
  );

  // Per-database My Work config, persisted in user preferences (MN-072 part 2).
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
      const { error } = await api.PATCH('/api/v1/users/me/preferences', {
        body: { myWork: { [dbId]: config } } as never,
      });
      if (error) throw error;
    },
    onMutate: ({ dbId, config }) => {
      qc.setQueryData(
        ['preferences'],
        (old: { myWork?: Record<string, MyWorkDbConfig> } | undefined) => ({
          ...(old ?? {}),
          myWork: { ...(old?.myWork ?? {}), [dbId]: config },
        }),
      );
    },
    onError: () => void qc.invalidateQueries({ queryKey: ['preferences'] }),
  });

  const grouped = useQuery({
    queryKey: ['my-work', ws, tab],
    enabled: tab !== 'activity',
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
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/recent', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { records: RecentRecord[] };
    },
  });

  const loading = tab === 'activity' ? activity.isLoading : grouped.isLoading;
  const groups = grouped.data?.groups ?? [];
  const recent = activity.data?.records ?? [];
  const empty = !loading && (tab === 'activity' ? recent.length === 0 : groups.length === 0);

  // #199 — filter → sort → group ONCE, and read both the rendered structure and the
  // flat triage order out of that single result. Deriving the ↑/↓ order separately
  // would be a second ordering implementation, free to drift from what the screen
  // shows; the arrow keys must walk exactly the rows you can see, in the order you
  // see them. Collapsed groups are excluded because their rows are not on screen.
  const view = useMemo(() => {
    const rendered = groups.map((group) => {
      const fields = (group.fields ?? []) as DenseField[];
      const config = myWork[group.database.id] ?? EMPTY_MYWORK;
      const filtered = group.records.filter((r) => matchesFilters(r.values, config));
      // MN-252: apply the same persisted sort spec before grouping, so precedence
      // holds within each sub-group (groupRecords preserves input order per bucket).
      const sorted = sortMyWorkRecords(filtered, fields, config);
      return {
        group,
        fields,
        config,
        chips: visibleFields(fields, config),
        count: filtered.length,
        subGroups: groupRecords(sorted, fields, config, memberNames),
      };
    });
    const queue: { dbId: string; record: MyWorkRecord }[] = [];
    for (const r of rendered) {
      if (collapsed.has(r.group.database.id)) continue;
      for (const sg of r.subGroups) {
        for (const record of sg.records) queue.push({ dbId: r.group.database.id, record: record as MyWorkRecord });
      }
    }
    return { rendered, queue };
  }, [groups, myWork, memberNames, collapsed]);

  // The row currently shown in the split panel. Null until a row is opened INTO the
  // panel — which is also what arms ↑/↓ below, so a plain My Work page never steals
  // the arrow keys from ordinary page scrolling.
  const [activeId, setActiveId] = useState<string | null>(null);
  const split = useSplitPanel();
  // 'swap': walking the queue replaces the panel's record instead of stacking a
  // rail for every row you passed.
  const openRecord = useOpenRecord('swap');

  // Open a queue entry in the panel. Returns false when the split declined it
  // (mobile, modifier-click, no provider) so the caller can let its `<Link>`
  // navigate instead — the same decision every other surface makes.
  const openInPanel = useCallback(
    (dbId: string, record: MyWorkRecord, event: Parameters<typeof openRecord>[1]) => {
      let navigated = false;
      openRecord(
        { db: dbId, rec: recordSegment(record), title: record.title, number: record.number },
        event,
        () => {
          navigated = true;
        },
      );
      if (!navigated) setActiveId(record.id);
      return !navigated;
    },
    [openRecord],
  );

  // #199 — ↑/↓ triage. Armed only while a record is open in the panel; walks the
  // same `view.queue` the screen renders and swaps the panel's record in place, so
  // there is no navigation and no lost scroll position.
  const queueRef = useRef(view.queue);
  queueRef.current = view.queue;
  useEffect(() => {
    if (!activeId || !split?.isDesktop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // Never hijack the arrows while someone is typing — in a panel field, a
      // filter box, or any editable surface.
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const queue = queueRef.current;
      const i = queue.findIndex((q) => q.record.id === activeId);
      if (i === -1) return;
      const next = queue[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      split!.replace({
        db: next.dbId,
        rec: recordSegment(next.record),
        title: next.record.title,
        number: next.record.number,
      });
      setActiveId(next.record.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId, split]);

  return (
    <div className="p-4 sm:p-8">
      <h1 className="mb-1 text-xl font-semibold text-ink">My Work</h1>
      <p className="mb-5 text-sm text-muted">Everything with your name on it, across databases.</p>

      <div className="mb-6 flex gap-1 border-b border-border-default">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              tab === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {empty && (
        <p className="max-w-3xl rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-[13px] text-muted">
          {tab === 'assigned' && 'Nothing assigned to you yet. When someone sets you in a Person field, it shows up here.'}
          {tab === 'created' && "You haven't created any records yet."}
          {tab === 'activity' && 'No recent activity yet.'}
        </p>
      )}

      {tab !== 'activity' &&
        view.rendered.map(({ group, fields, config, chips, count, subGroups }) => {
          const isCollapsed = collapsed.has(group.database.id);
          return (
            <div key={group.database.id} className="mb-6 max-w-4xl">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wider text-faint">
                <button
                  className="flex items-center gap-1 hover:text-ink"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.database.id)) next.delete(group.database.id);
                      else next.add(group.database.id);
                      return next;
                    })
                  }
                >
                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                <Link
                  href={`/w/${ws}/d/${group.database.id}`}
                  className="flex items-center gap-1.5 hover:text-ink"
                >
                  <EntityIcon
                    icon={group.database.icon}
                    color={group.database.color}
                    fallback={<Database className="h-3.5 w-3.5" />}
                  />
                  {group.database.name}
                  <span className="text-faint">{count}</span>
                </Link>
              </div>
              {!isCollapsed && (
                <>
                  {fields.length > 0 && (
                    <MyWorkGroupToolbar
                      fields={fields}
                      config={config}
                      members={memberList}
                      onChange={(next) => saveConfig.mutate({ dbId: group.database.id, config: next })}
                    />
                  )}
                  <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
                    {subGroups.map((sg) => (
                      <div key={sg.key}>
                        {sg.key !== '_all' && (
                          <GroupHeader label={sg.label} color={sg.color} count={sg.records.length} />
                        )}
                        {sg.records.map((record) => {
                          const tint = rowColor(record.values, fields, config);
                          return (
                            <Link
                              key={record.id}
                              href={`/w/${ws}/d/${group.database.id}/r/${record.id}`}
                              // #199 — opens beside the queue in the split panel on
                              // desktop. The `href` stays real so cmd/middle-click
                              // still opens a new tab and below `md` the plain
                              // navigation runs, exactly as before.
                              onClick={(e) => openInPanel(group.database.id, record, e)}
                              // flex-wrap: at 375px a few chips + the date won't fit
                              // beside the title on one line — they wrap to their own
                              // row (below) instead of forcing horizontal overflow,
                              // since those items are shrink-0 and refuse to squeeze.
                              className={cn(
                                'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default px-4 py-2.5 last:border-b-0 hover:bg-hover',
                                // #199 — the active row: which item the panel is
                                // showing, so ↑/↓ triage has a visible cursor.
                                record.id === activeId && 'bg-active',
                              )}
                              aria-current={record.id === activeId ? 'true' : undefined}
                              style={tint ? { boxShadow: `inset 3px 0 0 ${tint}` } : undefined}
                            >
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                                {record.title || 'Untitled'}
                              </span>
                              <span className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
                                {chips.map((f) =>
                                  record.values[f.api_name] != null ? (
                                    <span key={f.id} className="flex max-w-[10rem] items-center text-[12px]">
                                      <CellDisplay
                                        field={toField(f)}
                                        value={record.values[f.api_name]}
                                        memberNames={memberNames}
                                        memberImages={memberImages}
                                      />
                                    </span>
                                  ) : null,
                                )}
                                <span className="w-16 shrink-0 text-right text-[11px] text-faint">
                                  {fmt.date(record.updated_at)}
                                </span>
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}

      {tab === 'activity' && recent.length > 0 && (
        <div className="max-w-3xl overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
          {recent.map((r) => (
            <Link
              key={r.id}
              href={`/w/${ws}/d/${r.database_id}/r/${r.id}`}
              className="flex items-center justify-between border-b border-border-default px-4 py-2.5 last:border-b-0 hover:bg-hover"
            >
              <span className="flex min-w-0 items-center gap-2">
                <EntityIcon icon={r.database_icon} color={null} fallback={<Database className="h-3.5 w-3.5" />} />
                <span className="truncate text-[13px] font-medium text-ink">{r.title || 'Untitled'}</span>
              </span>
              <span className="shrink-0 text-[11px] text-faint">{r.database_name}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
