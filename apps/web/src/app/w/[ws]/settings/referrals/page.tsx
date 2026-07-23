'use client';

import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ReferralSummary {
  enabled: boolean;
  code: string | null;
  link: string | null;
  signups: number;
  paidConversions: number;
  rewardCents: number;
  terms: string;
}

/**
 * #33 — cloud-only (StripeService.enabled, mirrored via `enabled` in the
 * response, same as MN-166's billing status). This page itself is reachable
 * on self-host if someone types the URL directly — the API just returns
 * `enabled: false` and a null code/link, and this page renders the same
 * "not available" state SettingsLayout's nav-hiding is meant to make
 * unreachable in the normal click-path.
 */
export default function ReferralsPage() {
  const referrals = useQuery({
    queryKey: ['referrals-me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/referrals/me');
      if (error) throw error;
      return data as unknown as ReferralSummary;
    },
  });

  if (referrals.isLoading) return <div className="p-4 text-[13px] text-muted sm:p-8">Loading…</div>;
  if (!referrals.data) return null;
  const r = referrals.data;

  if (!r.enabled) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <h1 className="mb-1 text-lg font-semibold text-ink">Referrals</h1>
        <p className="text-[13px] text-muted">
          Referrals is a cloud feature and isn’t available on this self-hosted instance.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Referrals</h1>
      <p className="mb-6 text-[13px] text-muted">
        Invite people to StoryOS. When someone signs up through your link and their workspace
        goes paid, you earn a reward.
      </p>

      <Section title="Your referral link" description="Anyone who signs up through this link is attributed to you.">
        <div className="flex gap-2">
          <Input readOnly value={r.link ?? ''} onFocus={(e) => e.target.select()} />
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(r.link ?? '');
              toast.success('Copied');
            }}
          >
            Copy
          </Button>
        </div>
      </Section>

      <Section title="Your rewards">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Sign-ups" value={r.signups} />
          <Stat label="Paying conversions" value={r.paidConversions} />
          <Stat label="Earned rewards" value={`$${(r.rewardCents / 100).toFixed(2)}`} />
        </div>
      </Section>

      <Section title="Terms">
        <p className="text-[13px] text-muted">{r.terms}</p>
      </Section>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 border-b border-border-default pb-8 last:border-b-0 last:pb-0">
      <h2 className="mb-1 text-sm font-medium text-ink">{title}</h2>
      {description && <p className="mb-3 text-[13px] text-muted">{description}</p>}
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-border-default bg-card p-4">
      <p className="text-lg font-semibold text-ink">{value}</p>
      <p className="text-[12px] text-muted">{label}</p>
    </div>
  );
}
