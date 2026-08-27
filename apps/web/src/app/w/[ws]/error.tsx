'use client';

import { useEffect } from 'react';
import { AlertTriangle, ArrowLeft, RotateCw } from 'lucide-react';
import { reportError } from '@/lib/report-error';

/**
 * #424 — the workspace-level backstop.
 *
 * Placed at `w/[ws]` rather than higher on purpose: Next renders a segment's
 * `error.tsx` INSIDE that segment's layout, and the sidebar plus workspace
 * chrome live in `w/[ws]/layout.tsx`. So a crash in any view leaves the app
 * navigable — you keep your place in the workspace and can click into anything
 * else, instead of being dropped on a bare page with a Reload button.
 *
 * The narrower boundaries (the toolbar, each dashboard tile, each board column,
 * the record pane) are the ones that should normally catch first; this exists
 * for what they miss.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { boundary: 'workspace-route' });
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-[var(--radius-control)] border border-border-default bg-card p-4">
        <div className="flex items-center gap-2 font-medium text-ink">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          This view couldn’t be shown
        </div>
        <p className="mt-1.5 text-[13px] text-muted">
          The rest of your workspace is still open — you can pick another database in the sidebar.
          This has been reported.
        </p>
        {/* The digest is the only handle a user can quote that ties their
            report to ours, so it is shown rather than hidden. */}
        {error.digest ? (
          <p className="mt-2 font-mono text-[11px] text-faint">Reference: {error.digest}</p>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] text-ink hover:bg-hover"
          >
            <RotateCw className="h-3.5 w-3.5" /> Try again
          </button>
          <button
            type="button"
            onClick={() => window.history.back()}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Go back
          </button>
        </div>
      </div>
    </div>
  );
}
