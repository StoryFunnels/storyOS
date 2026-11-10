'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { usePreferences, useUpdatePreferences } from '@/lib/preferences';
import type { UserPreferences } from '@/lib/preferences';
import { useWorkspace } from '@/lib/queries';
import { canOpenAdminSettings } from '@/lib/settings-nav';
import { SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsRow } from '@/components/settings/settings-chrome';
import { MyWorkEmailBox } from '@/components/settings/my-work-email-box';
import { EMAILED_EVENTS, EMAIL_SETUP_DOCS_URL, emailLine, useMeMail } from '@/lib/my-work-email';

const EVENTS: { key: keyof UserPreferences['notifications']; label: string; description: string }[] = [
  { key: 'assigned', label: 'Assigned to me', description: 'When a record is assigned to you' },
  { key: 'mentioned', label: 'Mentions', description: 'When someone @mentions you' },
  { key: 'commented', label: 'Comments', description: 'On records you watch' },
  { key: 'state_changed', label: 'Status changes', description: 'A status or priority change on a record you’re assigned to' },
  // #591 — the API already enforced this opt-out (watcher-email.service.ts);
  // this row was simply never added when the toggle shipped.
  { key: 'record_changed', label: 'Record changes', description: 'Any field on records you watch, not just status' },
];

/**
 * Notifications (ticket #1189, Dara's #974 design): one box, a row per kind of event, the switch on the right. An admin also gets
 * the pointer the design draws: GitHub review notifications are a workspace setting, not a personal one, so they live on the GitHub
 * page, and this page says where.
 */
export default function NotificationsPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const isAdmin = canOpenAdminSettings((workspace.data as { role?: string } | undefined)?.role);
  const prefs = usePreferences();
  const update = useUpdatePreferences();
  const me = useMeMail();
  const line = emailLine(me.data);

  const toggle = (key: keyof UserPreferences['notifications'], value: boolean) => {
    update.mutate(
      { notifications: { [key]: value } },
      { onError: () => toast.error('Could not save — try again') },
    );
  };

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Notifications" lead="What reaches your Inbox. Everything is on by default." />

      <SettingsPageBody>
        <SettingsBox>
          {EVENTS.map(({ key, label, description }) => (
            <SettingsRow
              key={key}
              title={
                <>
                  {label}
                  {line.kind === 'sent' && EMAILED_EVENTS.has(key) && (
                    <span className="ml-2 rounded-[var(--radius-chip)] bg-hover px-1.5 py-0.5 align-middle text-meta font-semibold text-ink-secondary">Also by email</span>
                  )}
                </>
              }
              description={description}
              inlineControls
            >
              <Switch
                checked={prefs.data?.notifications[key] ?? true}
                disabled={prefs.isLoading}
                aria-label={label}
                onCheckedChange={(v) => toggle(key, v)}
              />
            </SettingsRow>
          ))}
        </SettingsBox>
        {/* Ticket #1264: a fact about THIS person, not an operator detail. Only the two events that email today carry the tag above. */}
        {line.kind === 'sent' && (
          <p className="text-label text-muted">
            We also email these to <b className="font-medium text-ink">{line.email}</b>, from{' '}
            {line.senderName ? `${line.senderName} (${line.senderAddress})` : line.senderAddress}.{' '}
            <Link href={`/w/${ws}/settings/account`} className="font-medium text-primary-text underline-offset-2 hover:underline">
              Change your address in Profile
            </Link>
          </p>
        )}
        {line.kind === 'not_set_up' && (
          <p className="text-label text-muted">
            Email isn{'\u2019'}t set up on this StoryOS server. Ask your admin.
            {isAdmin && (
              <>
                {' '}
                <a href={EMAIL_SETUP_DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary-text underline-offset-2 hover:underline">
                  How to set it up
                </a>
              </>
            )}
          </p>
        )}
        <MyWorkEmailBox />
        {isAdmin && (
          <p className="text-label text-muted">
            GitHub review notifications are set for the whole workspace, on{' '}
            <Link href={`/w/${ws}/settings/integrations/github`} className="font-medium text-primary-text underline-offset-2 hover:underline">
              Integrations › GitHub
            </Link>
            .
          </p>
        )}
      </SettingsPageBody>
    </div>
  );
}
