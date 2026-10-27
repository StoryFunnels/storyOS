import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** #1092 — every page under /settings/members is workspace-admin only; see AdminsOnly. */
export default function MembersSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Members">{children}</AdminsOnly>;
}
