'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { RecordTemplate } from '@storyos/schemas';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { templateRowHint, useDeleteTemplate, useEditTemplate } from './record-templates';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * ticket #1240 - "Manage templates": rename, re-describe or delete the database's templates. What a template PRESETS comes from
 * the record it was saved from, so changing that is "Save as template" again on a better record, not a form here.
 */
export function ManageTemplatesDialog({
  ws,
  db,
  open,
  onOpenChange,
  templates,
}: {
  ws: string;
  db: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: readonly RecordTemplate[];
}) {
  const confirm = useConfirm();
  const edit = useEditTemplate(ws, db);
  const remove = useDeleteTemplate(ws, db);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const begin = (t: RecordTemplate) => {
    setEditing(t.id);
    setName(t.name);
    setDescription(t.description ?? '');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title="Manage templates" className="max-w-lg">
          {templates.length === 0 ? (
            <EmptyState variant="list" className="px-0" title="No templates yet. Open a record, then use Save as template in its menu." />
          ) : (
            <ul className="flex flex-col divide-y divide-border-default">
              {templates.map((t) =>
                editing === t.id ? (
                  <li key={t.id} className="py-2">
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const next = name.trim();
                        if (!next) return;
                        edit.mutate(
                          { id: t.id, name: next, description: description.trim() || null },
                          {
                            onSuccess: () => setEditing(null),
                            onError: () => toast.error('Could not save the template'),
                          },
                        );
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label="Template name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                      <Input
                        aria-label="Template description"
                        placeholder="Description (optional)"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" size="sm" disabled={!name.trim() || edit.isPending}>
                          Save
                        </Button>
                      </div>
                    </form>
                  </li>
                ) : (
                  <li key={t.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body text-ink">{t.name}</div>
                      {templateRowHint(t) && (
                        <div className="truncate text-label text-muted">{templateRowHint(t)}</div>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => begin(t)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Delete ${t.name}?`,
                          message: 'Records already made from it are not changed.',
                          confirmLabel: 'Delete template',
                          danger: true,
                        });
                        if (ok)
                          remove.mutate(t.id, {
                            onError: () => toast.error('Could not delete the template'),
                          });
                      }}
                    >
                      Delete
                    </Button>
                  </li>
                ),
              )}
            </ul>
          )}
          <div className="mt-4 flex justify-end">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Done
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
