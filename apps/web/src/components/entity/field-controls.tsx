'use client';

import { Tooltip } from '@/components/ui/tooltip';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pin, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { atLeast } from '@/lib/access';
import { Dialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChangeTypeDialog } from '@/components/table-view/change-type-dialog';
import { EditFieldDialog } from '@/components/table-view/edit-field-dialog';
import { useDeleteField } from '@/components/table-view/field-dialog-shared';
import { useDatabase } from '@/components/table-view/use-table-data';
import type { Field } from '@/components/table-view/use-table-data';
import { hidesWhenEmpty, zonesOf } from './entity-field-utils';
import type { Zone } from './entity-field-utils';

const ZONE_LABEL: Record<Zone, string> = { top: 'top strip', sidebar: 'sidebar', body: 'main body' };

/** Persist a merged patch onto a field's config (zone / order / hidden). */
export function useSetFieldConfig(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fieldId, config }: { fieldId: string; config: Record<string, unknown> }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: fieldId } },
        body: { config },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['database', ws, db] }),
  });
}

/** Dropdown that pulls an existing field into a zone. */
export function FieldPicker({
  label,
  candidates,
  onPick,
}: {
  label: string;
  candidates: Field[];
  onPick: (f: Field) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <DropdownMenu>
      <Tooltip label={label}>
        <DropdownMenuTrigger asChild>
          <button className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink" aria-label={label}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {candidates.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onPick(f)}>
            {f.displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Empty/populate affordance for the top strip — pin any movable field up top (MN-077). */
export function TopStripAdd({
  candidates,
  empty,
  onPick,
}: {
  candidates: Field[];
  empty: boolean;
  onPick: (f: Field) => void;
}) {
  if (candidates.length === 0 && !empty) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-default px-2 py-1.5 text-label text-muted hover:border-border-strong hover:text-ink"
          title="Pin a field to the top strip"
        >
          <Pin className="h-3 w-3" /> {empty ? 'Pin a field' : 'Pin'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="px-2 py-1.5 text-label text-faint">All fields already pinned.</p>
        ) : (
          candidates.map((f) => (
            <DropdownMenuItem key={f.id} onSelect={() => onPick(f)}>
              {f.displayName}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * #809 — which fields the chip row under the record title shows. Lives with the other
 * field-visibility controls ("New field", "N hidden"), not in its own corner, and writes the
 * SAME stored `top` zone the row reads. Per database, not per record or person.
 */
export function TopRowMenu({
  candidates,
  selectedIds,
  configured,
  onToggle,
}: {
  candidates: Field[];
  selectedIds: Set<string>;
  /** False while the row is the automatic one (nothing stored yet). */
  configured: boolean;
  onToggle: (field: Field, on: boolean) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-label text-muted hover:text-ink"
          title="Choose which fields show in the row under the title (for every record in this database)"
        >
          <Pin className="h-3 w-3" /> Top row
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <p className="px-2 py-1.5 text-label text-muted">
          {configured
            ? 'Shown under the title on every record in this database.'
            : 'Automatic: state, assignee and due date. Pick any field to choose your own.'}
        </p>
        {candidates.map((f) => (
          <DropdownMenuItem
            key={f.id}
            onSelect={(e) => {
              e.preventDefault();
              onToggle(f, !selectedIds.has(f.id));
            }}
          >
            <span className="mr-2 w-3 text-accent">{selectedIds.has(f.id) ? '✓' : ''}</span> {f.displayName}
          </DropdownMenuItem>
        ))}
        {configured && <p className="px-2 py-1.5 text-label text-faint">Clear every field to go back to automatic.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Per-field ⋯ menu: choose zones (a field can be in several), edit, hide, delete. */
export function FieldMenu({
  ws,
  db,
  field,
  onToggleZone,
  collection = false,
  hideZoneToggle = false,
}: {
  ws: string;
  db: string;
  field: Field;
  onToggleZone: (field: Field, zone: Zone) => void;
  collection?: boolean;
  /** #780 — field zoning (top/sidebar/body placement) is hidden now that every
   * scalar field renders in one unified area; toggling a zone nobody can see
   * anymore would be confusing, so the record page's own unified field row
   * passes this to suppress just those three items. `onToggleZone` itself
   * still works and is passed through unchanged — this only hides the menu
   * entries, per "hide the UI, don't touch the stored data or the code". */
  hideZoneToggle?: boolean;
}) {
  const [dialog, setDialog] = useState<'edit' | 'change-type' | null>(null);
  const deleteField = useDeleteField({ ws, db, field, onDone: () => setDialog(null) });
  const setConfig = useSetFieldConfig(ws, db);
  // Relations delete via the relations API, removing both paired fields — which needs
  // creator on the OTHER database too, so only offer it when the user really can (#136).
  const deleteTargetDb = useDatabase(ws, field.relation?.target_database_id ?? '');
  const canDelete =
    field.type !== 'title' &&
    !field.isSystem &&
    (field.type !== 'relation' || atLeast(deleteTargetDb.data?.my_access, 'creator'));
  // Collections & rich text are body-locked; scalars & single-refs can be shown in any zones.
  const zones = collection ? [] : zonesOf(field);

  return (
    <>
      <DropdownMenu>
        <Tooltip label="Options">
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`Options for ${field.displayName}`}
              className="rounded p-0.5 text-faint opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialog('edit')}>Edit field</DropdownMenuItem>
          {!collection &&
            !hideZoneToggle &&
            (['top', 'sidebar', 'body'] as Zone[]).map((z) => (
              <DropdownMenuItem
                key={z}
                onSelect={(e) => {
                  e.preventDefault();
                  onToggleZone(field, z);
                }}
              >
                <span className="mr-2 w-3 text-accent">{zones.includes(z) ? '✓' : ''}</span> Show in {ZONE_LABEL[z]}
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              setConfig.mutate({
                fieldId: field.id,
                // Writes an EXPLICIT boolean either way: "Always show" must be a stored
                // `false`, because for a collection the unset default is hide (#783).
                config: { hide_when_empty: !hidesWhenEmpty(field) },
              })
            }
          >
            {hidesWhenEmpty(field) ? 'Always show (even empty)' : 'Hide when empty'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfig.mutate({ fieldId: field.id, config: { entity_hidden: true } })}>
            Hide on record page
          </DropdownMenuItem>
          {canDelete && (
            <DropdownMenuItem className="text-error" onSelect={() => deleteField.mutate()}>
              Delete field
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === 'edit' && (
          <EditFieldDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} onChangeType={() => setDialog('change-type')} />
        )}
        {dialog === 'change-type' && <ChangeTypeDialog ws={ws} db={db} field={field} onDone={() => setDialog(null)} />}
      </Dialog>
    </>
  );
}
