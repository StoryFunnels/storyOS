'use client';

import { usePathname, useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { SettingsNav } from '@/components/settings/settings-nav';
import { useSettingsSignals } from '@/components/settings/use-settings-signals';
import { settingsNavCounts } from '@/lib/settings-home';
import { canOpenAdminSettings, settingsFlags, settingsNavGroups } from '@/lib/settings-nav';

/**
 * The Settings shell (#29/#30/#31, rebuilt by ticket #1185): the nav on the left and the active page on the right.
 *
 * What the nav holds is decided in `lib/settings-nav.ts` (five groups, each page declared once with who may open it); this file only
 * gathers the facts that decision needs (the viewer's role, whether this is a cloud deployment) and the real counts shown beside
 * entries. The page itself is still refused in-page for a role that types its URL (`AdminsOnly`, #1092): the nav hiding a link is not a gate.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { ws } = useParams<{ ws: string }>();
  const pathname = usePathname();

  const workspace = useQuery({
    queryKey: ['workspace', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { role: string };
    },
  });
  const role = workspace.data?.role;

  // MN-166: `enabled` is false on self-host (no STRIPE_SECRET_KEY) — Plan & billing only makes sense on a cloud instance, so it is
  // hidden rather than shown pointing at a section that would just 404/503 everything.
  const billing = useQuery({
    queryKey: ['billing-status', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/billing', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { enabled: boolean };
    },
    enabled: canOpenAdminSettings(role),
  });

  // #33: same cloud-only signal as billing, but user-scoped (not admin-gated) since a referral link belongs to a person, not a
  // workspace — every member, not just admins, sees it once it's on.
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

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <SettingsNav ws={ws} pathname={pathname} groups={groups} counts={counts} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
