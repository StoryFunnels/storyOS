import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** Ticket #1185 — Trash is workspace-admin only (the restore endpoints' own @MinRole('admin')); see AdminsOnly. */
export default function TrashSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Trash">{children}</AdminsOnly>;
}
