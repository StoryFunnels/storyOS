'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { API_URL, api } from '@/lib/api';
import { useDatabase } from '@/components/table-view/use-table-data';
import {
  TARGET_LABEL,
  imageThatWillBePublished,
  lengthFor,
  postSnapshotOf,
  type PostSnapshot,
} from './post-social-model';
import { usePendingApprovals, useSocialConnections } from './use-social';

/**
 * Ticket #826 — what an approver is actually approving.
 *
 * The approval used to be a one-line snippet ("Post to x: …"): no account, no full text, and no
 * image — the part most likely to be wrong and the one thing that cannot be taken back once public.
 * This shows the final text, the account it goes out as, and the image.
 *
 * THE IMAGE IS ATTACHED AT PUBLISH TIME, not frozen into the approval: the executor reads the
 * media field's first attachment from the record when the job runs. So this shows the record's
 * CURRENT first attachment and says that is what will be sent, rather than a picture of what was
 * there when the rule fired. (Web-side gap: the approval snapshot already carries `media_field_id`;
 * nothing rendered it.)
 *
 * Renders nothing for any approval that is not a post_social.
 */
export function PostApprovalPreview({ ws, approvalId, db, rec }: { ws: string; approvalId: string; db: string; rec: string }) {
  const approvals = usePendingApprovals(ws, true);
  const approval = approvals.data?.find((a) => a.id === approvalId);
  const snapshot = postSnapshotOf(approval);
  if (!snapshot) return null;
  return <Preview ws={ws} db={db} rec={rec} snapshot={snapshot} />;
}

function Preview({ ws, db, rec, snapshot }: { ws: string; db: string; rec: string; snapshot: PostSnapshot }) {
  const connections = useSocialConnections(ws);
  const database = useDatabase(ws, db);
  const mediaField = snapshot.media_field_id ? database.data?.fields.find((f) => f.id === snapshot.media_field_id) : undefined;
  const record = useQuery({
    queryKey: ['approval-record', ws, db, rec],
    enabled: Boolean(snapshot.media_field_id),
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db, rec } },
      });
      if (error) throw error;
      return data as unknown as { values: Record<string, unknown> };
    },
  });

  const account = connections.data?.find((c) => c.id === snapshot.connection_id);
  const reading = lengthFor(snapshot.target, snapshot.text);
  const image = mediaField ? imageThatWillBePublished(record.data?.values[mediaField.apiName]) : null;
  const base = `${API_URL}/api/v1/workspaces/${ws}/databases/${db}/records/${rec}/attachments`;
  // Only claimed once both the schema and the record have loaded: "no image" while still loading would be a false statement.
  const imageKnown = !snapshot.media_field_id || (Boolean(mediaField) && record.isSuccess);

  return (
    <span className="mt-2 block rounded-[var(--radius-control)] border border-border-default bg-card p-2.5" data-testid="post-approval-preview">
      <span className="block text-label font-medium text-ink-secondary">
        Will post to {TARGET_LABEL[snapshot.target]}
        {account ? ` · ${account.name}` : ''}
      </span>
      <span className="mt-1.5 block whitespace-pre-wrap break-words text-body text-ink">{snapshot.text}</span>
      {snapshot.link && <span className="mt-1 block break-all text-label text-info">{snapshot.link}</span>}

      {snapshot.media_field_id && imageKnown && image && (
        <span className="mt-2 block">
          {image.attachment.has_thumbnail ? (
            <img
              src={`${base}/${image.attachment.id}/thumbnail`}
              alt={image.attachment.filename}
              className="max-h-48 w-auto rounded border border-border-default object-contain"
            />
          ) : (
            <span className="inline-block rounded bg-hover px-2 py-1 text-label text-ink">{image.attachment.filename}</span>
          )}
          <span className="mt-1 block text-label text-muted">
            This image goes out with the post
            {image.extra > 0 ? ` (only the first of ${image.extra + 1} attachments is posted)` : ''}.
          </span>
        </span>
      )}
      {snapshot.media_field_id && imageKnown && !image && (
        <span className="mt-2 flex items-start gap-1.5 text-label text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          This record has no image in “{mediaField?.displayName}” — the post will go out without one.
        </span>
      )}
      {reading.over && (
        <span className="mt-2 flex items-start gap-1.5 text-label text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {reading.length} of {reading.limit} characters — too long for {TARGET_LABEL[snapshot.target]}; it will be refused before it is sent.
        </span>
      )}
    </span>
  );
}
