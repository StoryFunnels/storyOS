'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { canOpenAdminSettings } from '@/lib/settings-nav';

/**
 * Ticket #1092 — the ONE "admins only" state for a workspace settings page.
 *
 * The settings nav hides an admin page from a member, but "hiding a link is not a gate" (the connect-ai page's own words, #875): a
 * member who types the URL used to get the page anyway, built for an admin. Its reads were refused by the API, so Billing was blank,
 * Webhooks said "No webhooks yet" next to a live Add button, and the Integrations forms failed on save. This wraps a settings route
 * (from its `layout.tsx`, so every page under it, present and future, is covered without each remembering to check) and says why.
 *
 * It checks the same role the nav does (`canOpenAdminSettings`, admin only) and refuses BEFORE rendering the page, so the page's own
 * requests are never made: a member's browser stops sending calls the API is going to refuse. It does not replace the API's
 * `@MinRole('admin')`, which still decides; this only stops showing a broken screen for it.
 */
export function AdminsOnly({ title, children }: { title: string; children: ReactNode }) {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useQuery({
    queryKey: ['workspace', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}', { params: { path: { ws } } } as never);
      if (error) throw error;
      return data as unknown as { role: string; name: string };
    },
  });
  if (workspace.isPending) return <p className="p-6 text-body text-muted">Loading…</p>;
  if (workspace.isError) {
    return (
      <p className="p-6 text-body text-error" role="alert">
        Could not check your access. Try again in a moment.
      </p>
    );
  }
  if (!canOpenAdminSettings(workspace.data.role)) return <AdminsOnlyNotice title={title} role={workspace.data.role} />;
  return <>{children}</>;
}

/** The refusal itself, exported so it can be rendered and tested without a query client. */
export function AdminsOnlyNotice({ title, role }: { title: string; role: string }) {
  return (
    <div className="p-6" data-testid="admins-only">
      <h1 className="text-title font-semibold text-ink">{title}</h1>
      <p className="mt-2 max-w-prose text-body text-muted">
        {title} is for workspace admins. You are {role === 'guest' ? 'a guest' : 'a member'} here, so you cannot open or change it. Ask a
        workspace admin if you need something changed.
      </p>
    </div>
  );
}
