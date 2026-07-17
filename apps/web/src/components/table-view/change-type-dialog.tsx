'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { Field } from './use-table-data';
import { CONVERTIBLE, useFieldMutations } from './field-dialog-shared';

export function ChangeTypeDialog({
  ws,
  db,
  field,
  onDone,
}: {
  ws: string;
  db: string;
  field: Field;
  onDone: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const targets = CONVERTIBLE[field.type] ?? [];
  const [target, setTarget] = useState(targets[0] ?? '');
  const [dryRun, setDryRun] = useState<{ records_affected: number; lossy_conversions: number } | null>(null);

  const check = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/change-type',
        {
          params: { path: { ws, db, field: field.id } },
          body: { type: target as never, dry_run: true },
        },
      );
      if (error) throw error;
      return data as unknown as { records_affected: number; lossy_conversions: number };
    },
    onSuccess: setDryRun,
  });

  const apply = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/change-type',
        { params: { path: { ws, db, field: field.id } }, body: { type: target as never } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success('Type changed');
      onDone();
    },
  });

  if (targets.length === 0) {
    return (
      <DialogContent title="Change type">
        <p className="text-sm text-muted">
          {field.type} fields cannot be converted. Delete the field and create a new one instead.
        </p>
        <div className="mt-4 flex justify-end">
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent title={`Change "${field.displayName}" type`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Convert {field.type} to</Label>
          <select
            className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setDryRun(null);
            }}
          >
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {dryRun ? (
          <p className="text-[13px] text-ink-secondary">
            {dryRun.records_affected} record(s) will convert.{' '}
            {dryRun.lossy_conversions > 0 ? (
              <span className="text-warning">
                {dryRun.lossy_conversions} value(s) cannot convert and will be cleared.
              </span>
            ) : (
              'No values will be lost.'
            )}
          </p>
        ) : (
          <p className="text-[13px] text-muted">Run the check to see what this conversion affects.</p>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          {dryRun ? (
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
              Convert
            </Button>
          ) : (
            <Button onClick={() => check.mutate()} disabled={check.isPending}>
              Check impact
            </Button>
          )}
        </div>
      </div>
    </DialogContent>
  );
}
