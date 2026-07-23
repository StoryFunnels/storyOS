'use client';

import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';

/** Unified settings shell (#29/#30/#31): a left sub-nav + the active page.
 * Personal sections are available to everyone; workspace sections are admin-only. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { ws } = useParams<{ ws: string }>();
  const pathname = usePathname();

  const workspace = useQuery({
    queryKey: ['workspace', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { role: string };
    },
  });
  const role = workspace.data?.role;
  const isAdmin = role === 'admin';
  const canEdit = role !== 'guest';

  // MN-166: `enabled` is false on self-host (no STRIPE_SECRET_KEY) — the Billing
  // link only makes sense on a cloud instance, so it's hidden rather than shown
  // pointing at a section that would just 404/503 everything.
  const billing = useQuery({
    queryKey: ['billing-status', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/billing', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { enabled: boolean };
    },
    enabled: isAdmin,
  });

  // #33: same cloud-only signal as Billing above, but user-scoped (not
  // admin-gated) since a referral link belongs to a person, not a workspace —
  // every member, not just admins, should see it once it's on.
  const referrals = useQuery({
    queryKey: ['referrals-me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/referrals/me');
      if (error) throw error;
      return data as unknown as { enabled: boolean };
    },
  });

  const base = `/w/${ws}/settings`;
  const personal = [
    { href: `${base}/account`, label: 'Account' },
    { href: `${base}/preferences`, label: 'Preferences' },
    { href: `${base}/notifications`, label: 'Notifications' },
    ...(referrals.data?.enabled ? [{ href: `${base}/referrals`, label: 'Referrals' }] : []),
  ];
  const workspaceLinks = [
    ...(isAdmin ? [{ href: `${base}/members`, label: 'Members' }] : []),
    ...(isAdmin && billing.data?.enabled ? [{ href: `${base}/billing`, label: 'Billing' }] : []),
    ...(isAdmin ? [{ href: `${base}/integrations`, label: 'Integrations' }] : []),
    ...(canEdit ? [{ href: `${base}/api`, label: 'API tokens' }] : []),
  ];
  const allLinks = [...personal, ...workspaceLinks];

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      {/* MN-230e: under md the two-pane side-nav collapses into a single
       * horizontal scrollable tab bar; at md+ it's the grouped vertical
       * side-nav (the `md:hidden` / `hidden md:block` pair below toggles it). */}
      <nav className="shrink-0 border-b border-border-default bg-sidebar md:w-52 md:border-b-0 md:border-r md:p-3">
        <div className="flex gap-1 overflow-x-auto px-3 py-2 md:hidden">
          {allLinks.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-[13px] ${
                  active
                    ? 'bg-active font-medium text-ink'
                    : 'text-ink-secondary hover:bg-hover'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
        <div className="hidden md:block">
          <SettingsNavGroup title="Personal" links={personal} pathname={pathname} />
          {workspaceLinks.length > 0 && (
            <SettingsNavGroup title="Workspace" links={workspaceLinks} pathname={pathname} />
          )}
        </div>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function SettingsNavGroup({
  title,
  links,
  pathname,
}: {
  title: string;
  links: { href: string; label: string }[];
  pathname: string;
}) {
  return (
    <div className="mb-4">
      <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
        {title}
      </p>
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`block rounded px-2 py-1 text-[13px] ${
              active
                ? 'bg-active font-medium text-ink'
                : 'text-ink-secondary hover:bg-hover'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </div>
  );
}
