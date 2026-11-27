import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SlackEvent, SlackSubscriptionDto } from '@/lib/slack-subscriptions';

const key = (ws: string) => ['slack-subscriptions', ws] as const;
const PATH = '/api/v1/workspaces/{ws}/integrations/slack/subscriptions';

/** Ticket #1388 — every Slack subscription in the workspace (the API lists them all, admin-only); a screen filters to its own target. */
export function useSlackSubscriptions(ws: string, enabled = true) {
  return useQuery({
    queryKey: key(ws),
    queryFn: async () => {
      const { data, error } = await api.GET(PATH as never, { params: { path: { ws } } } as never);
      if (error) throw error;
      return ((data as unknown as { data: SlackSubscriptionDto[] }).data ?? []) as SlackSubscriptionDto[];
    },
    enabled,
  });
}

export function useSlackSubscriptionMutations(ws: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: key(ws) });
  return {
    create: useMutation({
      mutationFn: async (body: { space_id?: string; database_id?: string; channel?: string; events: SlackEvent[]; acknowledge_restricted?: boolean }) => {
        const { data, error } = await api.POST(PATH as never, { params: { path: { ws } }, body } as never);
        if (error) throw error;
        return data;
      },
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await api.DELETE(`${PATH}/{id}` as never, { params: { path: { ws, id } } } as never);
        if (error) throw error;
      },
      onSuccess: refresh,
    }),
  };
}
