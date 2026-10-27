import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** #1092 — every page under /settings/integrations is workspace-admin only; see AdminsOnly. */
export default function IntegrationsSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Integrations">{children}</AdminsOnly>;
}
