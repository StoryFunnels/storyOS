'use client';

import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { SidebarMenuAction } from '@/components/sidebar-row-menu';
import { cn } from '@/lib/utils';
import { useViewMutations } from './use-view-state';
import type { ViewMenuHandlers, ViewMenuItem } from './view-menu';

/** The Radix door (the toolbar ⋯ and the tab ⋯ / right-click). One renderer, so the two cannot differ. */
export function ViewMenuItems({ items }: { items: ViewMenuItem[] }) {
  return (
    <>
      {items.map((item, i) => {
        const Icon = item.icon;
        const body = (
          <>
            <Icon className="mr-2 h-3.5 w-3.5" />
            {item.label}
          </>
        );
        return (
          <Fragment key={item.id}>
            {item.separatorBefore && i > 0 && <DropdownMenuSeparator />}
            {item.href ? (
              <DropdownMenuItem asChild>
                <a href={item.href}>{body}</a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={item.onSelect}
                disabled={Boolean(item.disabledReason)}
                title={item.disabledReason}
                className={cn(item.danger && 'text-error')}
              >
                {body}
              </DropdownMenuItem>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/** The sidebar door: the same items, as the sidebar row menu's own action shape. */
export function viewMenuSidebarActions(items: ViewMenuItem[]): SidebarMenuAction[] {
  return items.map((item) => {
    const Icon = item.icon;
    return {
      label: item.label,
      icon: <Icon className="mr-2 h-3.5 w-3.5" />,
      onSelect: item.onSelect,
      href: item.href,
      danger: item.danger,
      disabledReason: item.disabledReason,
      separatorBefore: item.separatorBefore,
    };
  });
}

/** The deep link to a view: `?view=` on its database (#347 changed no URLs). */
export function viewLink(origin: string, ws: string, db: string, viewId: string): string {
  return `${origin}/w/${ws}/d/${db}?view=${viewId}`;
}

/**
 * The actions every door runs identically, bound to one database. Doors differ in what they add on
 * top (the toolbar's widget and CSV), never in how these behave.
 */
export function useViewMenuActions(ws: string, db: string | null | undefined) {
  const router = useRouter();
  // `useViewMutations` needs a database id; a space-level view has none and gets no database actions.
  const mutations = useViewMutations(ws, db ?? '');
  if (!db) return null;
  return {
    mutations,
    duplicate: (viewId: string) =>
      mutations.duplicateView.mutate(viewId, { onSuccess: (v) => router.replace(`/w/${ws}/d/${db}?view=${v.id}`) }),
    setDefault: (viewId: string) => mutations.setDefaultView.mutate(viewId),
    copyToPersonal: (viewId: string) => mutations.copyViewToPersonal.mutate(viewId),
    copyLink: async (viewId: string) => {
      try {
        await navigator.clipboard.writeText(viewLink(window.location.origin, ws, db, viewId));
        toast.success('Link copied');
      } catch {
        toast.error('Could not copy the link');
      }
    },
    /** Opens the share dialog on the view's own page; the page reads `?share=` (see page.tsx). */
    share: (viewId: string) => router.push(`/w/${ws}/d/${db}?view=${viewId}&share=1`),
  };
}

/** The toolbar door's rename (the tab renames inline; the sidebar has its own dialog). */
export function RenameViewDialog({
  open,
  onOpenChange,
  name,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title="Rename view">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const next = draft.trim();
              if (next && next !== name) onRename(next);
              onOpenChange(false);
            }}
          >
            <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!draft.trim()}>
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * "Move to ‹folder›" for the tab and toolbar doors. It reads the SAME folders query the sidebar does
 * (`['folders', ws, space]`), so it costs no extra request when the sidebar is open.
 *
 * These doors do not know which folder a view is in (the database payload does not carry it), so they
 * offer every folder, and moving a view to the folder it is already in is a harmless no-op. Only the
 * sidebar, which does know, adds "Move back under its database" for a foldered view.
 */
export function useViewMoves(ws: string, db: string, spaceId: string | undefined) {
  const qc = useQueryClient();
  const folders = useQuery({
    queryKey: ['folders', ws, spaceId],
    enabled: Boolean(spaceId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/folders', {
        params: { path: { ws, space: spaceId! } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Array<{ id: string; name: string }> }).data;
    },
  });
  const move = useMutation({
    mutationFn: async (v: { id: string; folderId: string | null }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
        params: { path: { ws, db, view: v.id } },
        body: { folder_id: v.folderId } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['space-views', ws, spaceId] });
      void qc.invalidateQueries({ queryKey: ['database', ws, db] });
      toast.success('View moved');
    },
    onError: () => toast.error('Could not move the view'),
  });
  return (viewId: string): NonNullable<ViewMenuHandlers['moves']> =>
    (folders.data ?? []).map((f) => ({
      id: f.id,
      label: `Move to ${f.name}`,
      onSelect: () => move.mutate({ id: viewId, folderId: f.id }),
    }));
}
