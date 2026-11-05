import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The related database's records (id + title), the candidate groups of a view grouped by a relation.
 * One query for the board and the list (ticket #1147), so they share a cache key AND a fetch and cannot
 * disagree about which related records exist. One page (limit 100): callers must also add any chip they
 * find on a loaded row, so a record beyond this page still gets its own group.
 */
export function useRelationGroupTargets(ws: string, targetDb: string | undefined) {
  return useQuery({
    queryKey: ['board-groups', ws, targetDb],
    enabled: Boolean(targetDb),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb! }, query: { limit: 100 } },
      });
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; title: string }> }).data;
    },
  });
}
