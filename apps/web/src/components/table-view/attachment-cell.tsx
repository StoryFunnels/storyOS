'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
/**
 * #391 — the projected attachment shape and its byte formatter live HERE, not in
 * `cells.tsx`.
 *
 * `cells.tsx` imports the editor below, so importing back from it would close a
 * module cycle — which `import-cycles.unit.test.ts` (#315) catches, and did.
 * Dependencies point one way: cells → attachment-cell.
 */
export interface AttachmentValue {
  id: string;
  filename: string;
  size: number;
  mime: string;
  has_thumbnail: boolean;
}

/** Bytes as something a person reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Editing an attachment FIELD (#391).
 *
 * This is not a normal cell editor and cannot be. Every other editor produces a
 * value the record PATCH then stores; a file has to reach object storage first,
 * so uploads go straight to the attachment endpoint with `?field=` and the
 * record's value is written server-side.
 *
 * The consequence worth knowing: this editor commits on its own as you go, and
 * `onCancel` closes it rather than undoing anything. An "OK / Cancel" frame
 * around a file that is already in the bucket would be a lie.
 *
 * Removing detaches AND deletes the file, matching the record-level strip. A
 * "remove from this field but keep the file" state would leave orphans no
 * surface lists.
 */
export function AttachmentEditor({
  ws,
  db,
  rec,
  fieldId,
  value,
  onCancel,
}: {
  ws: string;
  db: string;
  rec: string;
  fieldId: string;
  value: unknown;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const files = Array.isArray(value) ? (value as AttachmentValue[]) : [];
  const base = `${API_URL}/api/v1/workspaces/${ws}/databases/${db}/records/${rec}/attachments`;

  /*
   * BOTH record query keys, and that is not belt-and-braces.
   *
   * The grid reads `['records', ws, db]`; the record page reads
   * `['record', ws, db, rec]`. Invalidating only the first meant a removal
   * persisted server-side and the properties panel went on showing the file —
   * caught in a live browser, not by a test: the API said `cover: []` while the
   * screen still listed it, which is the worst kind of disagreement because the
   * user's next move is to click Remove again.
   *
   * The record-level `['attachments', …]` key is deliberately NOT invalidated:
   * it backs the bag, and field files are not in the bag.
   */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['records', ws, db] });
    void qc.invalidateQueries({ queryKey: ['record', ws, db] });
  };

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`${base}?field=${fieldId}`, {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        if (!res.ok) throw new Error(await res.text());
      }
      refresh();
    } catch {
      toast.error('Upload failed — too large?');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`${base}/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(await res.text());
      refresh();
    } catch {
      toast.error('Could not remove the file');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-[220px] rounded-[var(--radius-control)] border border-border-strong bg-card p-2 shadow-[0_4px_12px_rgba(15,23,41,0.15)]">
      {files.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-1.5 text-[12px]">
              <span aria-hidden>{f.has_thumbnail ? '🖼' : '📎'}</span>
              <span className="min-w-0 flex-1 truncate" title={f.filename}>
                {f.filename}
              </span>
              <span className="shrink-0 text-faint">{formatBytes(f.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.filename}`}
                disabled={busy}
                onClick={() => void remove(f.id)}
                className="shrink-0 rounded px-1 text-muted hover:bg-hover hover:text-error disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void upload(e.target.files)}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className={cn(
            'rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] hover:bg-hover',
            busy && 'opacity-50',
          )}
        >
          {busy ? 'Working…' : files.length ? 'Add another' : 'Upload'}
        </button>
        <button type="button" onClick={onCancel} className="px-1 text-[12px] text-muted hover:text-ink">
          Done
        </button>
      </div>
      {files.length > 1 && (
        <p className="mt-1.5 text-[11px] text-faint">The first file is the one a gallery card shows.</p>
      )}
    </div>
  );
}
