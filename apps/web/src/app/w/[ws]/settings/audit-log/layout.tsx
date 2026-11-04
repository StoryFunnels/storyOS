import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** Ticket #1185 — the Audit log is workspace-admin only (audit-log.controller.ts's own @MinRole('admin')); see AdminsOnly. */
export default function AuditLogSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Audit log">{children}</AdminsOnly>;
}
