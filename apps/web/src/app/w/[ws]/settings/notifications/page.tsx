'use client';

import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { usePreferences, useUpdatePreferences } from '@/lib/preferences';
import type { UserPreferences } from '@/lib/preferences';

const EVENTS: { key: keyof UserPreferences['notifications']; label: string; description: string }[] = [
  { key: 'assigned', label: 'Assigned to me', description: 'A record is assigned to you.' },
  { key: 'mentioned', label: 'Mentions', description: 'Someone @mentions you in a comment.' },
  { key: 'commented', label: 'Comments', description: 'A new comment on a record you follow.' },
];

export default function NotificationsPage() {
  const prefs = usePreferences();
  const update = useUpdatePreferences();

  const toggle = (key: keyof UserPreferences['notifications'], value: boolean) => {
    update.mutate(
      { notifications: { [key]: value } },
      { onError: () => toast.error('Could not save — try again') },
    );
  };

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Notifications</h1>
      <p className="mb-6 text-[13px] text-muted">
        Choose what shows up in your inbox. Everything is on by default.
      </p>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        {EVENTS.map(({ key, label, description }) => (
          <div
            key={key}
            className="flex items-center justify-between gap-4 border-b border-border-default px-4 py-3.5 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{label}</p>
              <p className="text-[12px] text-muted">{description}</p>
            </div>
            <Switch
              checked={prefs.data?.notifications[key] ?? true}
              disabled={prefs.isLoading}
              aria-label={label}
              onCheckedChange={(v) => toggle(key, v)}
            />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-faint">Email notifications arrive when email delivery is enabled.</p>
    </div>
  );
}
