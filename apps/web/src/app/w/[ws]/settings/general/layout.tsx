import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** Ticket #1185 — General is for workspace admins and is not in a member's or guest's nav (Ievgen, #974 AC5a); by URL they get the shared refusal. */
export default function GeneralSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="General">{children}</AdminsOnly>;
}
