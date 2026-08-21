'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { DashboardView } from '@/components/views/dashboard-view';
import type { ViewConfig } from '@/components/views/use-view-state';

/**
 * #306 — the view-first route, for a view that owns no database.
 *
 * A space-level dashboard cannot be addressed under `/w/:ws/d/:db` because there
 * is no `:db`. This is the ONLY URL the whole initiative adds: #347 deliberately
 * shipped none, and every existing `/w/:ws/d/:db?view=…` link still resolves
 * exactly as before.
 *
 * Only dashboards reach here — the API refuses to create any other space-level
 * view type, because everything else renders rows OF a database.
 */
interface ViewDetail {
  id: string;
  name: string;
  type: string;
  config: ViewConfig;
  database_id: string | null;
  space_id: string | null;
}

export default function SpaceViewPage() {
  const params = useParams<{ ws: string; view: string }>();
  const ws = params.ws;
  const viewId = params.view;
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['view', ws, viewId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/views/{view}', {
        params: { path: { ws, view: viewId } },
      } as never);
      if (error) throw error;
      return data as unknown as ViewDetail;
    },
  });

  const save = useMutation({
    mutationFn: async (config: ViewConfig) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/views/{view}', {
        params: { path: { ws, view: viewId } },
        body: { config } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['view', ws, viewId] }),
    onError: () => toast.error('Could not save the dashboard'),
  });

  if (query.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;
  /**
   * A failed load says so. #346 fixed exactly this class of lie on the database
   * views — a failed query rendering as "nothing here" — and a new route must not
   * reintroduce it.
   */
  if (query.isError) {
    return (
      <p className="p-6 text-sm text-error">
        This view could not be loaded. You may not have access to it, or it may have been deleted.
      </p>
    );
  }
  if (!query.data) return <p className="p-6 text-sm text-error">View not found.</p>;

  const view = query.data;
  const config = (view.config ?? {}) as ViewConfig;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="border-b border-border-default px-6 py-3">
        <h1 className="text-[15px] font-semibold text-ink">{view.name}</h1>
      </div>
      <div className="flex-1 p-6">
        <DashboardView
          ws={ws}
          // No `db` — that is the entire point of this route.
          spaceId={view.space_id ?? undefined}
          config={config}
          readOnly={false}
          onPatch={(patch) => save.mutate({ ...config, ...patch } as ViewConfig)}
        />
      </div>
    </div>
  );
}
