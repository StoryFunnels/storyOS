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

  const base = `/w/${ws}/settings`;
  const personal = [
    { href: `${base}/account`, label: 'Account' },
    { href: `${base}/preferences`, label: 'Preferences' },
    { href: `${base}/notifications`, label: 'Notifications' },
  ];
  const workspaceLinks = [
    ...(isAdmin ? [{ href: `${base}/members`, label: 'Members' }] : []),
    ...(isAdmin && billing.data?.enabled ? [{ href: `${base}/billing`, label: 'Billing' }] : []),
    ...(isAdmin ? [{ href: `${base}/integrations`, label: 'Integrations' }] : []),
    ...(canEdit ? [{ href: `${base}/api`, label: 'API tokens' }] : []),
  ];

  return (
    <div className="flex min-h-full">
      <nav className="w-52 shrink-0 border-r border-border-default bg-sidebar p-3">
        <SettingsNavGroup title="Personal" links={personal} pathname={pathname} />
        {workspaceLinks.length > 0 && (
          <SettingsNavGroup title="Workspace" links={workspaceLinks} pathname={pathname} />
        )}
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
