'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useAiConnections } from '@/lib/ai-connections';
import { useInstalledPacks } from '@/components/pack-install-dialog';
import { currentWorkspaceId, splitTokens, type ScopedToken, type WorkspaceRef } from '@/app/w/[ws]/settings/api/token-scope';
import type { SettingsSignals } from '@/lib/settings-home';
import { deriveSettingsSignals } from '@/lib/settings-signals';
import { canConnectAi, canOpenAdminSettings } from '@/lib/settings-nav';

/**
 * The real figures behind the Settings nav counts and the home cards (ticket #1185). Each query uses the same key and shape as the
 * page it summarises, so opening that page costs no second request, and each is only ASKED by a role that may read it (a member's
 * browser never requests the members list the API would refuse). A query that has not answered, or failed, leaves its signal
 * `undefined`: see `SettingsSignals`.
 */
export function useSettingsSignals(ws: string, role: string | undefined): SettingsSignals {
  const admin = canOpenAdminSettings(role);
  const editor = canConnectAi(role) && role !== undefined;
  const { data: session } = useSession();

  const members = useQuery({
    queryKey: ['members', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', { params: { path: { ws } } });
      if (error) throw error;
      return data as unknown as unknown[];
    },
    enabled: admin,
  });
  const invites = useQuery({
    queryKey: ['invites', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/invites', { params: { path: { ws } } });
      if (error) throw error;
      return data as unknown as Array<{ expires_at: string }>;
    },
    enabled: admin,
  });
  const connections = useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', { params: { path: { ws } } } as never);
      if (error) throw error;
      return (data as unknown as { data: Array<{ name: string; status: string }> }).data;
    },
    enabled: admin,
  });
  const packs = useInstalledPacks(ws, admin);
  const ai = useAiConnections(ws, editor);
  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/me/tokens');
      if (error) throw error;
      return (data as unknown as { data: Array<ScopedToken & { last_used_at: string | null }> }).data;
    },
    enabled: editor,
  });
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces');
      if (error) throw error;
      return data as unknown as WorkspaceRef[];
    },
    enabled: editor,
  });

  // Tokens are per person across workspaces; only the ones that work HERE count, as the API tokens page shows.
  const currentId = currentWorkspaceId(ws, workspaces.data);
  const tokensHere = tokens.data && currentId ? splitTokens(tokens.data, currentId).here : undefined;

  return deriveSettingsSignals(
    {
      userName: session?.user.name,
      members: admin ? members.data : undefined,
      invites: admin ? invites.data : undefined,
      connections: admin ? connections.data : undefined,
      packs: admin ? packs.data : undefined,
      aiConnections: editor ? ai.data : undefined,
      tokens: editor ? tokensHere : undefined,
    },
    Date.now(),
  );
}
