'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, Settings, type LucideIcon } from 'lucide-react';
import { GlyphSlot, SidebarRow } from '@/components/sidebar-row';
import { SidebarTierLabel } from '@/components/sidebar-tier-label';
import { useSettingsBackHref } from '@/components/settings/use-settings-back';
import { useSettingsMenuData } from '@/components/settings/use-settings-menu';
import { SETTINGS_BACK_ROW_CLASS, settingsCountClass, settingsMenu, settingsRowWeightClass } from '@/lib/settings-menu';
import { SETTINGS_PAGE_ICONS } from '@/components/settings/settings-page-icons';
import { cn } from '@/lib/utils';

/**
 * The app sidebar's body while the person is in Settings (ticket #1216): it REPLACES the space tree, below the workspace switcher
 * and search, which stay. "Back to <workspace>" first (it returns to the last page outside Settings), then Settings (home), then the
 * five groups as sidebar tier labels, each page a standard sidebar row with an icon and, where a real figure exists, a count at the
 * right. Rows are the sidebar's own `SidebarRow` and the label is its own `SidebarTierLabel`: nothing here restates their styles.
 *
 * What the menu holds per role is decided in `lib/settings-nav.ts`, unchanged; the middle column that used to draw it is gone.
 */
export function SettingsSidebarMenu({ ws }: { ws: string }) {
  const pathname = usePathname();
  const { groups, counts, workspaceName } = useSettingsMenuData(ws);
  const backHref = useSettingsBackHref(ws);
  const menu = settingsMenu(ws, pathname, groups, counts);

  return (
    <nav aria-label="Settings" className="scroll-quiet flex-1 overflow-y-auto pb-2 pt-0.5">
      <SidebarRow depth={0} className={SETTINGS_BACK_ROW_CLASS}>
        <Link href={backHref} className="flex h-full min-w-0 flex-1 items-center gap-1.5">
          <GlyphSlot>
            <ChevronLeft className="h-3.5 w-3.5" />
          </GlyphSlot>
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">Back to {workspaceName ?? 'workspace'}</span>
        </Link>
      </SidebarRow>
      <MenuRow href={menu.home.href} active={menu.home.active} label="Settings" Icon={Settings} />
      {menu.tiers.map((tier) => (
        <div key={tier.id} role="group" aria-label={tier.title}>
          <SidebarTierLabel className="mt-3">{tier.title}</SidebarTierLabel>
          {tier.rows.map((row) => (
            <MenuRow key={row.id} href={row.href} active={row.active} label={row.label} Icon={SETTINGS_PAGE_ICONS[row.id]} count={row.count} />
          ))}
        </div>
      ))}
    </nav>
  );
}

function MenuRow({
  href,
  active,
  label,
  Icon,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  Icon: LucideIcon;
  count?: { text: string; warn?: boolean };
}) {
  return (
    <SidebarRow depth={0} active={active}>
      <Link href={href} aria-current={active ? 'page' : undefined} className={cn('flex min-w-0 flex-1 items-center gap-2', settingsRowWeightClass(active))}>
        <GlyphSlot>
          <Icon className="h-3.5 w-3.5" />
        </GlyphSlot>
        <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{label}</span>
        {count && <span className={cn('shrink-0 text-meta font-medium tabular-nums', settingsCountClass(count))}>{count.text}</span>}
      </Link>
    </SidebarRow>
  );
}
