'use client';

import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useDismissedHints } from '@/lib/dismissed-hints';
import { MY_WORK_OFFER_HINT, browserTimeZone, myWorkEmailOf, myWorkEmailPatch, showMyWorkOffer } from '@/lib/my-work-email';
import { usePreferences, useUpdatePreferences } from '@/lib/preferences';

/**
 * The one-time Inbox offer (ticket #1252): once a person has 5 or more open assigned records and "Email me my work" is Off, ask once
 * whether to email them daily. Every answer (the x, Not now, Email me daily) is final: it is stored as a dismissed hint on the server,
 * so it does not return on another device. Neutral tokens only (gold is for agents).
 *
 * The count is the exact `total` of GET my-work?tab=assigned (finished rows dropped), never the length of a page of rows.
 */
export function MyWorkEmailOffer({ ws }: { ws: string }) {
  const prefs = usePreferences();
  const update = useUpdatePreferences();
  const hints = useDismissedHints(ws);
  const open = useQuery({
    queryKey: ['my-work-open-total', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/my-work', { params: { path: { ws }, query: { tab: 'assigned' } } } as never);
      if (error) throw error;
      const total = (data as unknown as { total?: unknown } | undefined)?.total;
      return typeof total === 'number' ? total : undefined;
    },
    staleTime: 60_000,
  });

  if (!showMyWorkOffer({ email: myWorkEmailOf(prefs.data), dismissed: hints.dismissed, openAssigned: open.data })) return null;

  const answer = () => hints.setDismissed(MY_WORK_OFFER_HINT, true);
  const accept = () => {
    update.mutate(myWorkEmailPatch({ frequency: 'daily' }, browserTimeZone()), {
      onSuccess: () => {
        answer();
        toast.success('Daily email on: Monday to Friday. You can change it in Settings › Notifications.');
      },
      onError: () => toast.error('Could not save — try again'),
    });
  };

  return (
    <section aria-label="Email me my work" className="m-3 rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3 text-body">
      <div className="flex items-center">
        <b className="font-semibold text-ink">Get your open work by email?</b>
        <span className="flex-1" />
        <button type="button" onClick={answer} aria-label="Dismiss" className="-mr-1 rounded p-1 text-muted hover:bg-hover">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1 text-ink-secondary">A short list of what{'’'}s assigned to you, every weekday morning.</p>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" onClick={accept} disabled={update.isPending}>
          Email me daily
        </Button>
        <Button size="sm" variant="secondary" onClick={answer}>
          Not now
        </Button>
      </div>
    </section>
  );
}
