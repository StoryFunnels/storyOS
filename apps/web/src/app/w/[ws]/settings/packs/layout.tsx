import type { ReactNode } from 'react';
import { AdminsOnly } from '@/components/settings/admins-only';

/** Ticket #1186 — installing and removing packs is an admin act (the API's install and uninstall are admin-only), so a member or guest who types this URL gets the shared refusal. */
export default function PacksSettingsLayout({ children }: { children: ReactNode }) {
  return <AdminsOnly title="Packs">{children}</AdminsOnly>;
}
