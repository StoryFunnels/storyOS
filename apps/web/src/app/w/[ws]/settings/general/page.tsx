'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DESCRIPTION_MAX } from '@storyos/schemas';
import { Button } from '@/components/ui/button';
import { useSidebarMutations, useWorkspace } from '@/lib/queries';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Workspace General settings (#457).
 *
 * This route is new because the workspace had nowhere to put this. Space and
 * database each already own a context menu to hang a description on; the
 * workspace's settings area had pages for account, api, billing, connections,
 * export, integrations, members, notifications, preferences, referrals and
 * webhooks — and nothing for the workspace itself, with `/w/{ws}/settings`
 * rendering a 404. That gap is why #400's workspace description could be written
 * by an agent and by no one else.
 *
 * The editor here is NOT a third copy of the description control. The dialog
 * component (`components/description-dialog.tsx`) exists for the two menu-driven
 * levels; a settings page wants an inline field with its own Save, not a modal
 * opened from a menu. What must not fork is the RULES, and they do not: the cap
 * is `DESCRIPTION_MAX` from `packages/schemas/src/descriptions.ts` — the same
 * import the dialog uses — the over-limit measurement collapses whitespace the
 * same way, and clearing sends `null` so the server's `normalizeDescription`
 * removes it rather than storing `''`. There is one definition of "what a
 * description is" and both surfaces read it.
 */
export default function GeneralSettingsPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const { updateWorkspace } = useSidebarMutations(ws);
  const isAdmin = workspace.data?.role === 'admin';

  const [value, setValue] = useState('');
  // Seed the box once the workspace loads. Keyed on the fetched value so a
  // refetch that changes it upstream is reflected, but ordinary typing is not
  // clobbered on every render.
  const loaded = workspace.data?.description ?? '';
  useEffect(() => setValue(loaded), [loaded]);

  const measured = value.replace(/\s+/g, ' ').trim();
  const over = measured.length > DESCRIPTION_MAX;
  const dirty = measured !== (workspace.data?.description ?? '');

  const save = () => {
    if (over) return;
    updateWorkspace.mutate(
      // Empty box → null (remove it), never `''` — #305: absent and empty must
      // not become two states that render identically.
      { description: measured === '' ? null : value },
      {
        onSuccess: () => toast.success('Description saved'),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not save — try again')),
      },
    );
  };

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">General</h1>
      <p className="mb-6 text-[13px] text-muted">Settings for this workspace.</p>

      <section>
        <h2 className="mb-1 text-sm font-medium text-ink">Description</h2>
        <p className="mb-3 text-[13px] text-muted">
          One line saying what this workspace is for. Agents and teammates read it to understand
          what lives here.
        </p>
        <div className="flex max-w-xl flex-col gap-2">
          <textarea
            rows={3}
            value={value}
            disabled={!isAdmin || workspace.isLoading}
            onChange={(e) => setValue(e.target.value)}
            // No hard `maxLength`: silently truncating a pasted sentence teaches
            // the person nothing. Over-length is shown and Save is blocked.
            placeholder="What is this workspace for?"
            className={cn(
              'w-full resize-none rounded-[var(--radius-control)] border bg-card px-2 py-1.5 text-[13px] text-ink disabled:opacity-60',
              over ? 'border-error' : 'border-border-default',
            )}
          />
          <div className="flex items-center gap-3">
            <span className={cn('text-[12px] tabular-nums', over ? 'text-error' : 'text-faint')}>
              {over
                ? `${measured.length - DESCRIPTION_MAX} over the ${DESCRIPTION_MAX}-character limit`
                : `${DESCRIPTION_MAX - measured.length} left`}
            </span>
            <Button
              className="ml-auto"
              onClick={save}
              disabled={!isAdmin || over || !dirty || updateWorkspace.isPending}
            >
              {updateWorkspace.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {!isAdmin && (
            <p className="text-[12px] text-faint">Only an admin can change the workspace description.</p>
          )}
        </div>
      </section>
    </div>
  );
}
