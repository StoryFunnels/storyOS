import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** Ticket #1185 — Agent rules (this route, /governance, kept so old links resolve) is workspace-admin only; see AdminsOnly. */
export default function AgentRulesSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Agent rules">{children}</AdminsOnly>;
}
