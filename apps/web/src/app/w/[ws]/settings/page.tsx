'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Package, Plug, KeyRound, Sparkles, Trash2, UserRound, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/queries';
import { useDateFormat } from '@/lib/preferences';
import { useSettingsSignals } from '@/components/settings/use-settings-signals';
import { settingsHomeCards, type SettingsHomeCard } from '@/lib/settings-home';
import { settingsPageHref, type SettingsPageId } from '@/lib/settings-nav';

const ICONS: Record<string, LucideIcon> = {
  you: UserRound,
  members: Users,
  'connect-ai': Sparkles,
  'api-tokens': KeyRound,
  integrations: Plug,
  packs: Package,
  data: Trash2,
};

/** A card opens the nav entry of its page. Data & security has no page of its own: it opens its first one. */
const cardPage = (c: SettingsHomeCard): SettingsPageId => (c.page === 'data-and-security' ? 'export' : c.page);

const ROLE_WORDS: Record<string, string> = { admin: 'an admin', member: 'a member', guest: 'a guest' };

/**
 * `/settings` (ticket #1185): the Settings home. It was a 404. One card per area the viewer can open, each saying what needs
 * their attention, from real figures (`lib/settings-home.ts`): a number that no query has reported is not shown.
 */
export default function SettingsHomePage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const role = workspace.data?.role;
  const fmt = useDateFormat();
  const signals = useSettingsSignals(ws, role);
  const cards = role ? settingsHomeCards(role, signals, (iso) => fmt.date(iso)) : [];

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="text-lg font-bold leading-[1.3] tracking-[-0.01em] text-ink">Settings</h1>
      <p className="mb-[18px] mt-1 text-body text-muted">
        {workspace.data ? `${workspace.data.name} · you are ${ROLE_WORDS[role ?? ''] ?? `a ${role}`}` : 'Loading…'}
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5" data-testid="settings-home-cards">
        {cards.map((card) => {
          const Icon = ICONS[card.id] ?? Plug;
          return (
            <Link
              key={card.id}
              href={settingsPageHref(ws, cardPage(card))}
              className="flex min-h-[86px] flex-col gap-1 rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3 text-left text-body leading-[normal]! hover:border-border-strong"
            >
              <span className="flex items-center gap-1.5 text-label font-semibold leading-[normal]! text-muted">
                <Icon className="h-3 w-3" aria-hidden />
                {card.title}
              </span>
              {card.headline && <b className="text-prose font-[650] leading-[normal]! text-ink">{card.headline}</b>}
              {card.detail && (
                <span className={cn('text-label leading-[normal]!', card.tone === 'warn' ? 'text-warning-text' : 'text-muted')}>{card.detail}</span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
