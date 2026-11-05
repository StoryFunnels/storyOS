'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { INTEGRATION_FACTS } from '@/lib/integration-facts';
import type { ConnectionRow, IntegrationEndpoint, ProviderInfo } from '@/lib/provider-pages';

/** The workspace's saved credentials (`GET /connections`): status and health, never the secret. */
export function useConnections(ws: string) {
  return useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', { params: { path: { ws } } } as never);
      if (error) throw error;
      return (data as unknown as { data: ConnectionRow[] }).data;
    },
  });
}

/** The provider catalog with the server's availability verdict for THIS deployment (`GET /connections/providers`). */
export function useProviders(ws: string) {
  return useQuery({
    queryKey: ['connection-providers', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections/providers', { params: { path: { ws } } } as never);
      if (error) throw error;
      return (data as unknown as { data: ProviderInfo[] }).data;
    },
  });
}

/**
 * One integration's own config, folded to the facts a card needs. It has its OWN query key, not the provider page's: the GitHub page
 * seeds form state from inside its query function, so sharing a cache entry would let this read win and leave that form empty.
 */
export function useIntegrationFacts(ws: string, endpoint: IntegrationEndpoint) {
  return useQuery({
    queryKey: ['integration-facts', ws, endpoint],
    queryFn: async () => {
      const { data, error } = await api.GET(`/api/v1/workspaces/{ws}/integrations/${endpoint}` as '/api/v1/workspaces/{ws}/integrations/github', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return INTEGRATION_FACTS[endpoint](data as never);
    },
  });
}
