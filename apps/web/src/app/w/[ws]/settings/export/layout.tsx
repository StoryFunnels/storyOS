import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** Ticket #1185 — Export is workspace-admin only (the API's own @MinRole('admin')); see AdminsOnly. */
export default function ExportSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Export">{children}</AdminsOnly>;
}
