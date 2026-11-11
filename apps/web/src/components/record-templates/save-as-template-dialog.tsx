'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useSaveRecordAsTemplate } from './record-templates';

/** ticket #1240 - the record menu's "Save as template": the server reads the values and the description off the record, so a name is all we ask. */
export function SaveAsTemplateDialog({
  ws,
  db,
  rec,
  defaultName,
  open,
  onOpenChange,
}: {
  ws: string;
  db: string;
  rec: string;
  defaultName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title="Save as template" unsaved>
          <SaveForm
            ws={ws}
            db={db}
            rec={rec}
            defaultName={defaultName}
            onOpenChange={onOpenChange}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Its own component so the draft name starts from the record's title each time the dialog opens. */
function SaveForm({
  ws,
  db,
  rec,
  defaultName,
  onOpenChange,
}: {
  ws: string;
  db: string;
  rec: string;
  defaultName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveRecordAsTemplate(ws, db);
  const [name, setName] = useState(defaultName);
  return (
    <>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const next = name.trim();
          if (!next) return;
          save.mutate(
            { record_id: rec, name: next },
            {
              onSuccess: () => {
                toast.success(`Saved ${next} as a template`);
                onOpenChange(false);
              },
              onError: () => toast.error('Could not save the template'),
            },
          );
        }}
      >
        <p className="text-body text-muted">
          New will offer it, with this record&apos;s field values and description. The title is not
          copied.
        </p>
        <Input
          autoFocus
          aria-label="Template name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            Save template
          </Button>
        </div>
      </form>
    </>
  );
}
