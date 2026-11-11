import type { ReactNode } from 'react';
import { AdvancedSection } from '@/components/settings/settings-chrome';
import { setupDisclosure } from '@/lib/setup-disclosure';

/**
 * Ticket #1221 — wraps a provider page's setup content: closed behind "Change how <provider> is connected" once connected, drawn
 * as the page (unchanged) while it is not. The disclosure is the shared `AdvancedSection`.
 */
export function SetupDisclosure({
  label,
  connected,
  children,
}: {
  label: string;
  connected: boolean;
  children: ReactNode;
}) {
  const m = setupDisclosure(label, connected);
  if (!m.collapsed) return <>{children}</>;
  return (
    <div className="mb-5" data-testid="setup-disclosure">
      <AdvancedSection title={m.title} summary={m.summary}>
        <div className="flex flex-col gap-5 p-4">{children}</div>
      </AdvancedSection>
    </div>
  );
}
