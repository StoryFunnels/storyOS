'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ManageTemplatesDialog } from './manage-templates-dialog';
import {
  hasTemplateMenu,
  skippedMessage,
  templateRowHint,
  useApplyTemplate,
  useRecordTemplates,
} from './record-templates';

const PRIMARY =
  'border border-primary bg-primary text-label font-semibold text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-60';

/**
 * #964 - the toolbar's ONE primary button. It makes a blank record and opens it (what the mobile quick-add already does), on every
 * view type. It also answers `storyos:new-record`, the event the command palette's "New record here" has always dispatched.
 *
 * ticket #1240 - when the database has record templates the button grows a chevron that lists them; choosing one makes the record
 * from it and opens it. Plain New and the N shortcut are unchanged and never wait on the template list.
 */
export function NewRecordButton({ ws, db }: { ws: string; db: string }) {
  const router = useRouter();
  const templates = useRecordTemplates(ws, db);
  const apply = useApplyTemplate(ws, db);
  const [managing, setManaging] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db } },
        body: { values: {} },
      });
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`),
    onError: () => toast.error('Could not create the record'),
  });
  useEffect(() => {
    const onNew = () => create.mutate();
    window.addEventListener('storyos:new-record', onNew);
    return () => window.removeEventListener('storyos:new-record', onNew);
  }, [create]);

  const list = templates.data;
  const split = hasTemplateMenu(list);
  const busy = create.isPending || apply.isPending;

  const plain = (
    <button
      type="button"
      onClick={() => create.mutate()}
      disabled={busy}
      className={cn(
        'inline-flex h-[27px] shrink-0 items-center gap-1.5 px-[11px]',
        PRIMARY,
        split ? 'rounded-l-[var(--radius-control)]' : 'rounded-[var(--radius-control)]',
      )}
    >
      <Plus className="h-3.5 w-3.5" /> <span className="tb-new">New</span>
    </button>
  );
  if (!split) return plain;

  return (
    <>
      <div className="inline-flex shrink-0">
        {plain}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="New from a template"
              disabled={busy}
              className={cn(
                'inline-flex h-[27px] items-center rounded-r-[var(--radius-control)] shadow-[inset_1px_0_0_color-mix(in_srgb,var(--text-on-dark)_30%,transparent)] px-1.5',
                PRIMARY,
              )}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>New from a template</DropdownMenuLabel>
            {list?.map((t) => (
              <DropdownMenuItem
                key={t.id}
                className="flex-col items-start gap-0"
                onSelect={() =>
                  apply.mutate(t.id, {
                    onSuccess: ({ id, skipped }) => {
                      const warn = skippedMessage(skipped);
                      if (warn) toast.warning(warn);
                      router.push(`/w/${ws}/d/${db}/r/${id}`);
                    },
                    onError: () => toast.error(`Could not create a record from ${t.name}`),
                  })
                }
              >
                <span className="max-w-full truncate">{t.name}</span>
                {templateRowHint(t) && (
                  <span className="max-w-full truncate text-label text-muted">
                    {templateRowHint(t)}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setManaging(true)}>
              Manage templates...
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ManageTemplatesDialog
        ws={ws}
        db={db}
        open={managing}
        onOpenChange={setManaging}
        templates={list ?? []}
      />
    </>
  );
}
