'use client';

import { useParams } from 'next/navigation';
import { Download } from 'lucide-react';
import { API_URL } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';

/**
 * #320 — the owner's data-ownership hatch. StoryOS locks nothing in: an admin can
 * download the ENTIRE workspace (schema, records, relations, attachments) as a
 * single `.zip`. Admin-only, matching the API's `@MinRole('admin')` gate.
 *
 * The download is a plain link, not a fetch: the browser streams the (potentially
 * large) zip straight to disk instead of us buffering it into a blob. Credentials
 * ride the cookie the app already uses.
 */
export default function ExportPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const role = (workspace.data as { role?: string } | undefined)?.role;
  const isAdmin = role === 'admin';
  const href = `${API_URL}/api/v1/workspaces/${ws}/export/workspace.zip`;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Export workspace</h1>
      <p className="mb-6 text-[13px] text-muted">
        StoryOS locks nothing in. Download the entire workspace — every space,
        database, field, record, relation and attachment — as a single{' '}
        <code>.zip</code> you fully own.
      </p>

      {workspace.isLoading ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : isAdmin ? (
        <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Full workspace export</p>
              <p className="text-[13px] text-muted">
                A <code>.zip</code> with <code>manifest.json</code>, one JSON file per
                database (schema + records), the relation graph, and the attachment
                files. Large workspaces stream, so this may take a moment to start.
              </p>
            </div>
            <a
              href={href}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-4 text-[13px] font-medium text-[var(--text-on-dark)] transition-colors hover:bg-primary-hover"
              title="Download the whole workspace as a .zip"
            >
              <Download className="h-4 w-4" /> Export workspace
            </a>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted">
          Only workspace admins can export the whole workspace.
        </p>
      )}
    </div>
  );
}
