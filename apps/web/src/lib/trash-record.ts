import { toast } from 'sonner';
import { api } from '@/lib/api';
import { DESTRUCTIVE_TOAST_MS, pushUndo } from '@/lib/undo';

/**
 * #1275 — the ONE single-record delete action: move to Trash, then say so with
 * an Undo that calls the real restore endpoint. Ticket #1275's re-ruling:
 * no single-record delete happens on one tap without a way back, so there is
 * no confirm dialog for ONE record (bulk keeps its own confirm, batch-bar.tsx),
 * on every width.
 *
 * Every surface that deletes one record (the table row's trash, the record
 * panel's Delete) goes through `trashRecord`. Before this, the table row and the
 * record panel each carried their own copy: the row had an Undo toast and the
 * panel had none, and both said a generic "moved to trash" without naming the
 * record. A copy that drifts is how a delete ends up with no way back.
 */

export interface TrashRecordArgs {
  ws: string;
  db: string;
  rec: string;
  /** The record's title as the person saw it. Empty/absent is handled honestly, never invented. */
  title?: string | null;
  /**
   * The delete was made through a personal view. A personal view is a lens on
   * shared data (docs/architecture/personal-space.md section 3), so the delete
   * lands for everyone — the toast says so, replacing the confirmation's wording.
   */
  personalLens?: boolean;
  /** Runs after the record is trashed AND after a successful Undo — refresh the caller's caches. */
  onChanged?: () => void;
}

/** The toast line: names the record, and the blast radius when it is a personal lens. */
export function trashedMessage(title: string | null | undefined, personalLens = false): string {
  const name = title?.trim() ? `"${title.trim()}"` : 'this untitled record';
  return personalLens
    ? `Deleted ${name} for everyone in the workspace, not just this view`
    : `Deleted ${name}`;
}

/** The failure line for Undo: the record is still in Trash, and the line says so. */
export function restoreFailedMessage(title: string | null | undefined): string {
  const name = title?.trim() ? `"${title.trim()}"` : 'The record';
  return `Could not restore ${name}. It is still in the trash.`;
}

export async function requestTrash(ws: string, db: string, rec: string): Promise<void> {
  const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
    params: { path: { ws, db, rec } },
  });
  if (error) throw error;
}

export async function requestRestore(ws: string, db: string, rec: string): Promise<void> {
  const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/restore', {
    params: { path: { ws, db, rec } },
  });
  if (error) throw error;
}

/**
 * Announce a trashed record: the toast with Undo (10 s, DESTRUCTIVE_TOAST_MS) and the
 * Cmd-Z entry, sharing one restore closure so the two routes cannot drift (#265).
 * Call after the DELETE has succeeded.
 */
export function announceTrashed({ ws, db, rec, title, personalLens, onChanged }: TrashRecordArgs): void {
  const restore = async () => {
    await requestRestore(ws, db, rec);
    onChanged?.();
  };
  pushUndo({ label: 'Restored from trash', run: restore });
  toast.success(trashedMessage(title, personalLens), {
    duration: DESTRUCTIVE_TOAST_MS,
    action: {
      label: 'Undo',
      onClick: async () => {
        try {
          await restore();
          toast.success(title?.trim() ? `Restored "${title.trim()}"` : 'Restored');
        } catch {
          toast.error(restoreFailedMessage(title));
        }
      },
    },
  });
}

/** Trash one record, then announce it. Throws if the DELETE fails (nothing was announced). */
export async function trashRecord(args: TrashRecordArgs): Promise<void> {
  await requestTrash(args.ws, args.db, args.rec);
  args.onChanged?.();
  announceTrashed(args);
}
