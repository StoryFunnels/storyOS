'use client';

import { useParams } from 'next/navigation';
import { Download } from 'lucide-react';
import { API_URL } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/queries';
import { canOpenAdminSettings } from '@/lib/settings-nav';
import { SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsRow } from '@/components/settings/settings-chrome';

/**
 * #320 — the owner's data-ownership hatch. StoryOS locks nothing in: an admin can
 * download the ENTIRE workspace (schema, records, relations, attachments) as a
 * single `.zip`. Admin-only, matching the API's `@MinRole('admin')` gate.
 *
 * The download is a plain link, not a fetch: the browser streams the (potentially
 * large) zip straight to disk instead of us buffering it into a blob. Credentials
 * ride the cookie the app already uses.
 *
 * Ticket #1189: drawn in the Settings chrome (Dara's #974 design). What the zip holds and why the download may take a moment to
 * start are written under the box, visible, rather than left to a tooltip on the link.
 */
export default function ExportPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const isAdmin = canOpenAdminSettings((workspace.data as { role?: string } | undefined)?.role);
  const href = `${API_URL}/api/v1/workspaces/${ws}/export/workspace.zip`;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Export" lead={`A copy of everything in ${workspace.data?.name ?? 'this workspace'}. StoryOS locks nothing in.`} />

      {workspace.isLoading ? (
        <p className="text-body text-muted">Loading…</p>
      ) : isAdmin ? (
        <SettingsPageBody>
          <SettingsBox>
            <SettingsRow
              title="Export workspace"
              description="Every space, database, record, document and the access settings, as one zip. Personal spaces are never included."
            >
              <a
                href={href}
                className={cn(buttonVariants(), 'shrink-0 gap-1.5 max-sm:w-full')}
              >
                <Download className="h-4 w-4" aria-hidden /> Export
              </a>
            </SettingsRow>
          </SettingsBox>
          <p className="text-label text-muted">
            The <code>.zip</code> holds <code>manifest.json</code>, one JSON file per database (schema and records), the relation graph, and
            the attachment files. Large workspaces stream, so the download may take a moment to start.
          </p>
        </SettingsPageBody>
      ) : (
        <p className="text-body text-muted">Only workspace admins can export the whole workspace.</p>
      )}
    </div>
  );
}
