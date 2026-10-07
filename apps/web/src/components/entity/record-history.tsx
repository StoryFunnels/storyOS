'use client';

import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BlockChange } from '@storyos/schemas/block-diff';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { useMembers } from '@/components/table-view/use-table-data';
import type { Field } from '@/components/table-view/use-table-data';
import { blockPlainText } from './entity-field-utils';
import { USER_ID_FIELD_TYPES, formatActivityValue } from './activity-format';

interface FieldChange {
  id: string;
  field_id: string | null;
  field_name: string;
  actor_id: string | null;
  source: 'human' | 'agent' | 'automation' | 'mcp';
  old_value: unknown;
  new_value: unknown;
  old_display: string;
  new_display: string;
  created_at: string;
}
interface ChangesPage {
  data: FieldChange[];
  next_cursor: string | null;
  has_more: boolean;
}

interface VersionEntry {
  id: string;
  title: string;
  actor_id: string | null;
  // #677 (Gap 1) — the API has sent these since PR #843; this UI never read
  // them, which is the exact "visible-at-a-glance" gap #677's AC #3 names.
  source: 'human' | 'agent' | 'automation' | 'mcp';
  agent_id: string | null;
  agent_name: string | null;
  created_at: string;
}
interface VersionsPage {
  data: VersionEntry[];
  next_cursor: string | null;
  has_more: boolean;
}

interface VersionPreviewEntry {
  field_name: string;
  current_display: string;
  restored_display: string;
}
interface VersionPreview {
  id: string;
  preview: VersionPreviewEntry[];
}

/** #677 (Gap 2) — one entry in the document's OWN version list, sibling to
 * `VersionEntry` above but over `document_versions`, not `record_versions`. */
interface DocVersionEntry {
  id: string;
  actor_id: string | null;
  source: 'human' | 'agent' | 'automation' | 'mcp';
  agent_id: string | null;
  agent_name: string | null;
  created_at: string;
}
interface DocVersionsPage {
  data: DocVersionEntry[];
  next_cursor: string | null;
  has_more: boolean;
}
interface DocVersionPreview {
  id: string;
  blocks: BlockChange[];
}

/** #39 — badges the record history / audit trail by #390's `source` enum.
 * No existing generic badge for this (Tyron's own AgentBadge from #364 is
 * identity-specific, not a source label), so a small one lives here. */
const SOURCE_LABEL: Record<string, string> = {
  human: 'Person',
  agent: 'Agent',
  automation: 'Automation',
  mcp: 'MCP',
};

function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={cn(
        'rounded-[var(--radius-chip)] px-1.5 py-0.5 text-micro font-medium uppercase tracking-wide',
        source === 'human' ? 'bg-hover text-ink-secondary' : 'bg-accent-soft text-[var(--accent)]',
      )}
    >
      {SOURCE_LABEL[source] ?? source}
    </span>
  );
}

/**
 * #39 — the record history dialog: a per-field change timeline (who/when,
 * old → new, source-badged, with per-field revert) and a whole-record
 * version list (restore with a diff preview + confirmation). Both read
 * paths and the restore action already existed (MN-231, #31/C2); this is
 * the first UI over any of it. Per-field revert needs no new endpoint — the
 * ADR (docs/architecture/version-history.md) calls it "a targeted update()
 * with { [field_id]: old_value }", i.e. the same PATCH any other field edit
 * uses.
 */
export function RecordHistoryDialog({
  ws,
  db,
  rec,
  fields,
  readOnly,
  onClose,
}: {
  ws: string;
  db: string;
  rec: string;
  fields: Field[];
  readOnly: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'changes' | 'versions' | 'document'>('changes');
  const [confirmVersionId, setConfirmVersionId] = useState<string | null>(null);
  const [confirmDocVersionId, setConfirmDocVersionId] = useState<string | null>(null);
  const dateFormat = useDateFormat();
  const qc = useQueryClient();
  const members = useMembers(ws, true);
  const actorName = (id: string | null) =>
    id ? (members.data?.find((m) => m.user.id === id)?.user.name ?? '(removed member)') : '—';
  // #806 — the API's `*_display` resolves option ids but leaves a person field's
  // stored USER ID as it was written, so this list printed raw ids exactly like the
  // Activity tab did. Resolve by field TYPE, from the raw value, with the same
  // formatter and the same removed-member fallback.
  const shownValue = (display: string, raw: unknown, type: string | undefined) =>
    type && USER_ID_FIELD_TYPES.has(type) && raw !== null && raw !== undefined && raw !== ''
      ? formatActivityValue(raw, type, (id) => members.data?.find((m) => m.user.id === id)?.user.name)
      : display || '—';

  const changes = useInfiniteQuery({
    queryKey: ['record-field-changes', ws, db, rec],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = {};
      if (pageParam) query.cursor = pageParam;
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions/changes',
        { params: { path: { ws, db, rec }, query } } as never,
      );
      if (error) throw error;
      return data as unknown as ChangesPage;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const versions = useInfiniteQuery({
    queryKey: ['record-versions', ws, db, rec],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = {};
      if (pageParam) query.cursor = pageParam;
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions',
        { params: { path: { ws, db, rec }, query } } as never,
      );
      if (error) throw error;
      return data as unknown as VersionsPage;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const preview = useQuery({
    queryKey: ['record-version-preview', ws, db, rec, confirmVersionId],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions/{version}',
        { params: { path: { ws, db, rec, version: confirmVersionId! } } } as never,
      );
      if (error) throw error;
      return data as unknown as VersionPreview;
    },
    enabled: confirmVersionId !== null,
  });

  // #677 (Gap 2) — the document's own version list + restore, sibling to
  // `versions`/`restore`/`preview` above but over `document_versions`.
  const docVersions = useInfiniteQuery({
    queryKey: ['document-versions', ws, db, rec],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = {};
      if (pageParam) query.cursor = pageParam;
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document/versions',
        { params: { path: { ws, db, rec }, query } } as never,
      );
      if (error) throw error;
      return data as unknown as DocVersionsPage;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const docPreview = useQuery({
    queryKey: ['document-version-preview', ws, db, rec, confirmDocVersionId],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document/versions/{version}',
        { params: { path: { ws, db, rec, version: confirmDocVersionId! } } } as never,
      );
      if (error) throw error;
      return data as unknown as DocVersionPreview;
    },
    enabled: confirmDocVersionId !== null,
  });

  const restoreDoc = useMutation({
    mutationFn: async (versionId: string) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document/versions/{version}/restore',
        { params: { path: { ws, db, rec, version: versionId } } } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Document restored');
      setConfirmDocVersionId(null);
      // #677 — the description editor (BlockNote) is uncontrolled: it reads
      // `initialContent` once at creation, so invalidating the query alone
      // would not update what's on screen. A reload is exactly what this
      // same file's OWN conflict banner already does for "content changed
      // elsewhere" ("Reload theirs") — reusing that established pattern
      // rather than building a live-patch path for an editor that doesn't
      // support one.
      void qc.invalidateQueries({ queryKey: ['document', ws, db, rec] });
      window.location.reload();
    },
    onError: () => toast.error('Could not restore this document version'),
  });

  const invalidateRecord = () => {
    // #39 — deliberately a 3-element key, not ['record', ws, db, rec]: the
    // record-detail panel's own useRecordQuery caches under whatever the URL
    // gave it (a legacy uuid OR a pretty slug-{number}, see parseRecordParam
    // there), which is not necessarily the resolved `rec` id this dialog
    // receives. A 3-element key prefix-matches either cache entry; the exact
    // 4-element key silently matched neither and left the panel's header
    // showing a stale title after a real, successful restore.
    void qc.invalidateQueries({ queryKey: ['record', ws, db] });
    void qc.invalidateQueries({ queryKey: ['records', ws, db] });
    void qc.invalidateQueries({ queryKey: ['record-field-changes', ws, db, rec] });
  };

  const restore = useMutation({
    mutationFn: async (versionId: string) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/versions/{version}/restore',
        { params: { path: { ws, db, rec, version: versionId } } } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Record restored');
      setConfirmVersionId(null);
      invalidateRecord();
      void qc.invalidateQueries({ queryKey: ['record-versions', ws, db, rec] });
    },
    onError: () => toast.error('Could not restore this version'),
  });

  const revertField = useMutation({
    mutationFn: async ({ apiName, value }: { apiName: string; value: unknown }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db, rec } },
        body: { values: { [apiName]: value } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Field reverted');
      invalidateRecord();
    },
    onError: () => toast.error('Could not revert this field'),
  });

  const changeItems = (changes.data?.pages ?? []).flatMap((p) => p.data);
  const versionItems = (versions.data?.pages ?? []).flatMap((p) => p.data);
  const docVersionItems = (docVersions.data?.pages ?? []).flatMap((p) => p.data);

  return (
    <>
      <DialogContent title="History" className="max-w-lg">
        <div className="flex max-h-[70vh] flex-col gap-3">
          {/* #767 — the other hand-rolled switcher #738 left behind. */}
          <Segmented
            label="History view"
            value={tab}
            onChange={setTab}
            size="default"
            options={[
              { value: 'changes', label: 'Changes' },
              { value: 'versions', label: 'Versions' },
              { value: 'document', label: 'Document' },
            ]}
          />

          {tab === 'changes' && (
            <div className="flex flex-col gap-2 overflow-y-auto">
              {/* #669 — names the exact next state: nothing has happened here yet. */}
              {changeItems.length === 0 && !changes.isLoading && (
                <p className="py-4 text-center text-body text-muted">No changes recorded yet.</p>
              )}
              {changeItems.map((c) => {
                // #305/#39 — a field the change refers to may since have been
                // deleted or renamed; field_id is still there but `fields`
                // (the database's LIVE defs) may no longer have it. Revert is
                // only offered when the field genuinely still exists to write to.
                const field = c.field_id ? fields.find((f) => f.id === c.field_id) : null;
                const canRevert = !readOnly && c.field_id !== null && field !== undefined && field !== null;
                return (
                  <div key={c.id} className="rounded-[var(--radius-card)] border border-border-default p-2.5">
                    <div className="flex items-center gap-1.5 text-label text-muted">
                      <span className="font-medium text-ink">{actorName(c.actor_id)}</span>
                      <SourceBadge source={c.source} />
                      <span className="ml-auto shrink-0">{dateFormat.dateTime(c.created_at)}</span>
                    </div>
                    <p className="mt-1 text-body text-ink">
                      <span className="font-medium">{c.field_name}</span>:{' '}
                      <span className="text-muted line-through">{shownValue(c.old_display, c.old_value, field?.type)}</span>{' '}
                      <span aria-hidden>→</span> <span>{shownValue(c.new_display, c.new_value, field?.type)}</span>
                    </p>
                    {canRevert && field && (
                      <button
                        type="button"
                        onClick={() => revertField.mutate({ apiName: field.apiName, value: c.old_value })}
                        disabled={revertField.isPending}
                        className="mt-1 text-meta text-muted underline hover:text-ink disabled:opacity-50"
                      >
                        Revert this field
                      </button>
                    )}
                  </div>
                );
              })}
              {changes.hasNextPage && (
                <button
                  type="button"
                  onClick={() => changes.fetchNextPage()}
                  disabled={changes.isFetchingNextPage}
                  className="w-full py-2 text-center text-label text-muted hover:bg-hover disabled:opacity-50"
                >
                  {changes.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          )}

          {tab === 'versions' && (
            <div className="flex flex-col gap-2 overflow-y-auto">
              {versionItems.length === 0 && !versions.isLoading && (
                <p className="py-4 text-center text-body text-muted">No earlier versions yet.</p>
              )}
              {versionItems.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between gap-2 rounded-[var(--radius-card)] border border-border-default p-2.5"
                >
                  <div className="min-w-0 text-body">
                    <p className="truncate font-medium text-ink">{v.title || 'Untitled'}</p>
                    <p className="flex items-center gap-1.5 text-label text-muted">
                      <span>{actorName(v.actor_id)}</span>
                      <SourceBadge source={v.source} />
                      <span>· {dateFormat.dateTime(v.created_at)}</span>
                    </p>
                  </div>
                  {!readOnly && (
                    <Button size="sm" variant="secondary" onClick={() => setConfirmVersionId(v.id)}>
                      Restore
                    </Button>
                  )}
                </div>
              ))}
              {versions.hasNextPage && (
                <button
                  type="button"
                  onClick={() => versions.fetchNextPage()}
                  disabled={versions.isFetchingNextPage}
                  className="w-full py-2 text-center text-label text-muted hover:bg-hover disabled:opacity-50"
                >
                  {versions.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          )}

          {tab === 'document' && (
            <div className="flex flex-col gap-2 overflow-y-auto">
              {docVersionItems.length === 0 && !docVersions.isLoading && (
                <p className="py-4 text-center text-body text-muted">No earlier document versions yet.</p>
              )}
              {docVersionItems.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between gap-2 rounded-[var(--radius-card)] border border-border-default p-2.5"
                >
                  <div className="min-w-0 text-body">
                    <p className="flex items-center gap-1.5 text-label text-muted">
                      <span className="font-medium text-ink">{actorName(v.actor_id)}</span>
                      <SourceBadge source={v.source} />
                      <span>· {dateFormat.dateTime(v.created_at)}</span>
                    </p>
                  </div>
                  {!readOnly && (
                    <Button size="sm" variant="secondary" onClick={() => setConfirmDocVersionId(v.id)}>
                      Restore
                    </Button>
                  )}
                </div>
              ))}
              {docVersions.hasNextPage && (
                <button
                  type="button"
                  onClick={() => docVersions.fetchNextPage()}
                  disabled={docVersions.isFetchingNextPage}
                  className="w-full py-2 text-center text-label text-muted hover:bg-hover disabled:opacity-50"
                >
                  {docVersions.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          )}

          {/* #69 — "the UI must say how far back it goes": the exact per-plan
              day count (docs/architecture/version-history.md) lives behind
              GET .../billing, which is admin-only — this dialog is not, so it
              states the POLICY rather than fetching a number most viewers of
              this dialog aren't allowed to read. Flagged on the ticket as a
              real gap if the exact count matters enough for its own endpoint.
              PR #838 review: text-muted, not text-faint — this is informative
              prose someone needs to actually read, not decoration (globals.css
              reserves faint for decorative/non-text content). */}
          <p className="text-meta text-muted">
            History is retained for a window set by your workspace's plan — older changes are pruned automatically.
          </p>

          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>

      {/* #69 — restore shows a PREVIEW and asks for confirmation before
          applying. Its own <Dialog> Root, nested inside the panel's: this is
          a second, independently open/closeable dialog stacking over the
          panel above, not a second Content under the same Root — cancelling
          should return to exactly where the user was in the panel, not
          close both. */}
      <Dialog open={confirmVersionId !== null} onOpenChange={(open) => !open && setConfirmVersionId(null)}>
        {confirmVersionId && (
          <DialogContent title="Restore this version?" className="max-w-md">
            <div className="flex flex-col gap-3">
              {preview.isLoading && <p className="text-body text-muted">Loading preview…</p>}
              {!preview.isLoading && preview.data && preview.data.preview.length === 0 && (
                <p className="text-body text-muted">
                  This version is identical to the current record — nothing to restore.
                </p>
              )}
              {!preview.isLoading && preview.data && preview.data.preview.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-body text-muted">This will change:</p>
                  {preview.data.preview.map((p, i) => (
                    <p key={i} className="text-body text-ink">
                      <span className="font-medium">{p.field_name}</span>:{' '}
                      <span className="text-muted line-through">{p.current_display || '—'}</span>{' '}
                      <span aria-hidden>→</span> <span>{p.restored_display || '—'}</span>
                    </p>
                  ))}
                </div>
              )}
              {/* PR #838 review: text-muted, not text-faint — a reassurance
                  before a destructive-looking action is exactly the kind of
                  prose the reader needs, not decoration. */}
              <p className="text-label text-muted">
                Restoring is itself reversible — it saves the current state as a new version first.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmVersionId(null)}
                  disabled={restore.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => restore.mutate(confirmVersionId)}
                  disabled={restore.isPending || preview.isLoading}
                >
                  {restore.isPending ? 'Restoring…' : 'Restore'}
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* #677 (Gap 2) — document restore's own confirm+preview dialog,
          parallel to the record one above: a block-level diff (added /
          removed / changed), human-readable via `blockPlainText`, never raw
          JSON — and restore is itself reversible, same as the record path. */}
      <Dialog open={confirmDocVersionId !== null} onOpenChange={(open) => !open && setConfirmDocVersionId(null)}>
        {confirmDocVersionId && (
          <DialogContent title="Restore this document version?" className="max-w-md">
            <div className="flex flex-col gap-3">
              {docPreview.isLoading && <p className="text-body text-muted">Loading preview…</p>}
              {!docPreview.isLoading && docPreview.data && docPreview.data.blocks.length === 0 && (
                <p className="text-body text-muted">
                  This version is identical to the current document — nothing to restore.
                </p>
              )}
              {!docPreview.isLoading && docPreview.data && docPreview.data.blocks.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-body text-muted">This will change:</p>
                  {docPreview.data.blocks.map((b, i) => (
                    // #677 — the API computes `diffBlocks(version.content,
                    // current.content)`, i.e. before=the version being
                    // restored, after=CURRENT. So `to` is what's on screen
                    // NOW and `from` is what restoring will make it again —
                    // the reverse of the naive reading. Caught live: an
                    // earlier version of this rendered the diff backwards
                    // (restored value struck through, current value shown as
                    // the "new" one), which would have told a user
                    // confirming a restore the opposite of what would
                    // happen. 'added' (in current, not in the version) is
                    // therefore what restore REMOVES; 'removed' (in the
                    // version, not current) is what restore BRINGS BACK.
                    <p key={i} className="text-body text-ink">
                      {b.kind === 'added' && (
                        <span className="text-muted line-through">− {blockPlainText(b.to)}</span>
                      )}
                      {b.kind === 'removed' && <span>+ {blockPlainText(b.from)}</span>}
                      {b.kind === 'changed' && (
                        <>
                          <span className="text-muted line-through">{blockPlainText(b.to)}</span>{' '}
                          <span aria-hidden>→</span> <span>{blockPlainText(b.from)}</span>
                        </>
                      )}
                    </p>
                  ))}
                </div>
              )}
              <p className="text-label text-muted">
                Restoring is itself reversible — it saves the current document as a new version first.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmDocVersionId(null)}
                  disabled={restoreDoc.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => restoreDoc.mutate(confirmDocVersionId)}
                  disabled={restoreDoc.isPending || docPreview.isLoading}
                >
                  {restoreDoc.isPending ? 'Restoring…' : 'Restore'}
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
