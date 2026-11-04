'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { useSettingsSignals } from '@/components/settings/use-settings-signals';
import { settingsNavCounts } from '@/lib/settings-home';
import { canOpenAdminSettings, settingsFlags, settingsNavGroups } from '@/lib/settings-nav';

/**
 * What the Settings menu needs to know (tickets #1185, #1216): the viewer's role, whether this is a cloud deployment, and the real
 * figures shown beside entries. What the menu HOLDS is decided in `lib/settings-nav.ts`; this only gathers the facts that decision
 * needs. The page itself is still refused in-page for a role that types its URL (`AdminsOnly`, #1092): a hidden row is not a gate.
 */
export function useSettingsMenuData(ws: string) {
  const workspace = useWorkspace(ws);
  const role = workspace.data?.role;

  // MN-166: `enabled` is false on self-host (no STRIPE_SECRET_KEY): Plan & billing only makes sense on a cloud instance, so it is
  // hidden rather than shown pointing at a section that would just 404/503 everything.
  const billing = useQuery({
    queryKey: ['billing-status', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/billing', { params: { path: { ws } } } as never);
      if (error) throw error;
      return data as unknown as { enabled: boolean };
    },
    enabled: canOpenAdminSettings(role),
  });

  // #33: same cloud-only signal as billing, but user-scoped (not admin-gated): a referral link belongs to a person, not a workspace.
  const referrals = useQuery({
    queryKey: ['referrals-me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/referrals/me');
      if (error) throw error;
      return data as unknown as { enabled: boolean };
    },
  });

  const groups = settingsNavGroups(ws, role, settingsFlags(role, billing.data?.enabled, referrals.data?.enabled));
  const counts = settingsNavCounts(role, useSettingsSignals(ws, role));
  return { groups, counts, workspaceName: workspace.data?.name };
}
