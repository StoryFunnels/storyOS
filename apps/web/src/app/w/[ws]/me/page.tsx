'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
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
  toField,
  visibleFields,
} from '@/components/my-work/group-config';
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
 * and what I recently touched — the cross-database "what should I work on" home. */
export default function MyWorkPage() {
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

  return (
    <div className="p-8">
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
        groups.map((group) => {
          const isCollapsed = collapsed.has(group.database.id);
          const fields = (group.fields ?? []) as DenseField[];
          const config = myWork[group.database.id] ?? EMPTY_MYWORK;
          const chips = visibleFields(fields, config);
          const filtered = group.records.filter((r) => matchesFilters(r.values, config));
          const subGroups = groupRecords(filtered, fields, config, memberNames);
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
                  <span className="text-faint">{filtered.length}</span>
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
                              className="flex items-center gap-3 border-b border-border-default px-4 py-2.5 last:border-b-0 hover:bg-hover"
                              style={tint ? { boxShadow: `inset 3px 0 0 ${tint}` } : undefined}
                            >
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                                {record.title || 'Untitled'}
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
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
