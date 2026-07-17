'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { atLeast } from '@/lib/access';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDatabase } from './use-table-data';
import type { Field } from './use-table-data';
import {
  CONVERTIBLE,
  ConfigEditor,
  FIELD_TYPES,
  useDeleteField,
  useFieldMutations,
} from './field-dialog-shared';
import { RelationAutoLink } from './relation-auto-link';
import { LiveOptionsEditor } from './option-editors';

export function EditFieldDialog({
  ws,
  db,
  field,
  onDone,
  onChangeType,
}: {
  ws: string;
  db: string;
  field: Field;
  onDone: () => void;
  /** Provided by surfaces that can swap this dialog for the change-type flow. */
  onChangeType?: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const [name, setName] = useState(field.displayName);
  const [config, setConfig] = useState<Record<string, unknown>>(field.config ?? {});
  const deleteField = useDeleteField({ ws, db, field, onDone });
  const currentDb = useDatabase(ws, db);
  // MN-212: renaming to another field's name is refused server-side — flag it inline first.
  const duplicateName = useMemo(() => {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return false;
    return (currentDb.data?.fields ?? []).some(
      (f) => f.id !== field.id && f.displayName.trim().toLowerCase() === wanted,
    );
  }, [name, currentDb.data, field.id]);

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {};
      if (name.trim() && name !== field.displayName) patch.display_name = name.trim();
      if (JSON.stringify(config) !== JSON.stringify(field.config ?? {})) patch.config = config;
      if (Object.keys(patch).length === 0) return;
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: field.id } },
        body: patch as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: () => toast.error('Could not save the field'),
  });

  const isSelect = field.type === 'select' || field.type === 'multi_select';
  // Relations ARE deletable (via the relations API, handled in useDeleteField) —
  // deleting drops both paired fields, which needs creator on the OTHER database
  // too; only offer Delete when the user really can (#136).
  const deleteTargetDb = useDatabase(ws, field.relation?.target_database_id ?? '');
  const canDelete =
    field.type !== 'title' &&
    !field.isSystem &&
    (field.type !== 'relation' || atLeast(deleteTargetDb.data?.my_access, 'creator'));
  const canConvert = (CONVERTIBLE[field.type] ?? []).length > 0;
  const typeMeta = FIELD_TYPES.find((t) => t.value === field.type);

  return (
    <DialogContent title={`Edit "${field.displayName}"`} className="max-w-lg">
      <form
        className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto px-1 py-0.5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rename">Name</Label>
          <Input id="rename" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          {duplicateName && (
            <p className="text-[12px] text-error">A field named “{name.trim()}” already exists in this database.</p>
          )}
          <p className="text-[12px] text-faint">
            {typeMeta?.label ?? field.type} field · API name{' '}
            <code className="text-muted">{field.apiName}</code> stays stable across renames.
          </p>
        </div>

        {field.type === 'relation' && field.relation && (
          <>
            <p className="text-[13px] text-muted">
              Links to <span className="font-medium text-ink">{field.relation.target_database_name ?? 'a database'}</span>{' '}
              ({field.relation.cardinality === 'one_to_many' ? 'one-to-many' : 'many-to-many'}). Manage
              or remove the relation from either database's schema.
            </p>
            <RelationAutoLink ws={ws} relationId={field.relation.id} side={field.relation.side} />
          </>
        )}

        <ConfigEditor type={field.type} config={config} onChange={setConfig} />

        {isSelect && (
          <div className="flex flex-col gap-1.5">
            <Label>Options</Label>
            <LiveOptionsEditor ws={ws} db={db} field={field} />
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border-default pt-3">
          <div className="flex gap-2">
            {canDelete && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-error"
                onClick={() => deleteField.mutate()}
              >
                Delete field
              </Button>
            )}
            {canConvert && onChangeType && (
              <Button type="button" variant="ghost" size="sm" onClick={onChangeType}>
                Change type…
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending || duplicateName}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  );
}
