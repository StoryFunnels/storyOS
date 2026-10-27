import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** #1092 — every page under /settings/webhooks is workspace-admin only; see AdminsOnly. */
export default function WebhooksSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Webhooks">{children}</AdminsOnly>;
}
