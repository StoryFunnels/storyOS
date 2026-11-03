'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  isSettingsLinkActive,
  settingsHomeHref,
  type SettingsNavGroup,
  type SettingsNavLink,
  type SettingsPageId,
} from '@/lib/settings-nav';
import type { SettingsNavCount } from '@/lib/settings-home';

const ITEM = 'flex items-baseline justify-between gap-2 rounded-[var(--radius-control)] px-2.5 py-1.5 text-body leading-[normal]!';
const itemTone = (active: boolean) => (active ? 'bg-active font-[650] text-ink' : 'text-ink-secondary hover:bg-hover');

/**
 * The Settings nav (ticket #1185): a "Settings" home entry, then the viewer's groups. Presentational: the groups arrive already
 * filtered to what this role can open (`settingsNavGroups`), the counts arrive as real figures or not at all.
 *
 * Under md the same entries become one horizontal strip (the prototype's phone nav): the strip scrolls inside itself, never the page,
 * and group headings drop out.
 */
export function SettingsNav({
  ws,
  pathname,
  groups,
  counts,
}: {
  ws: string;
  pathname: string;
  groups: SettingsNavGroup[];
  counts: Partial<Record<SettingsPageId, SettingsNavCount>>;
}) {
  const home = settingsHomeHref(ws);
  const homeActive = pathname === home;
  const all = groups.flatMap((g) => g.links);

  return (
    <nav aria-label="Settings" className="shrink-0 border-b border-border-default bg-sidebar md:w-60 md:border-b-0 md:border-r md:px-2.5 md:pb-6 md:pt-[18px]">
      <div className="flex gap-1 overflow-x-auto px-2.5 py-2 md:hidden">
        <Link href={home} aria-current={homeActive ? 'page' : undefined} className={cn(ITEM, 'shrink-0 whitespace-nowrap', itemTone(homeActive))}>
          Settings
        </Link>
        {all.map((link) => (
          <NavLink key={link.id} link={link} pathname={pathname} count={counts[link.id]} compact />
        ))}
      </div>
      <div className="hidden flex-col gap-px md:flex">
        <Link href={home} aria-current={homeActive ? 'page' : undefined} className={cn(ITEM, itemTone(homeActive))}>
          Settings
        </Link>
        {groups.map((group, i) => (
          <div key={group.id} className="flex flex-col gap-px" role="group" aria-label={group.title}>
            <p className={cn('px-2.5 pb-1 text-meta font-semibold leading-[normal]! text-muted', i === 0 ? 'pt-1.5' : 'pt-3')}>{group.title}</p>
            {group.links.map((link) => (
              <NavLink key={link.id} link={link} pathname={pathname} count={counts[link.id]} />
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

function NavLink({
  link,
  pathname,
  count,
  compact = false,
}: {
  link: SettingsNavLink;
  pathname: string;
  count?: SettingsNavCount;
  compact?: boolean;
}) {
  const active = isSettingsLinkActive(pathname, link);
  return (
    <Link
      href={link.href}
      aria-current={active ? 'page' : undefined}
      className={cn(ITEM, itemTone(active), compact && 'shrink-0 whitespace-nowrap')}
    >
      <span>{link.label}</span>
      {count && <span className={cn('text-meta font-medium leading-[normal]!', count.warn ? 'text-warning-text' : 'text-muted')}>{count.text}</span>}
    </Link>
  );
}
