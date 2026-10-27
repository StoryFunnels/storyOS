import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** #1092 — every page under /settings/billing is workspace-admin only; see AdminsOnly. */
export default function BillingSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Billing">{children}</AdminsOnly>;
}
