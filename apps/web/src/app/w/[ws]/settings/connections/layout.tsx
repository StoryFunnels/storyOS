import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** #1092 — every page under /settings/connections is workspace-admin only; see AdminsOnly. */
export default function ConnectionsSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Connections">{children}</AdminsOnly>;
}
