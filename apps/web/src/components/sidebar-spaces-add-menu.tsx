'use client';

import { useState } from 'react';
import { LayoutTemplate, Plus, FolderPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { PHONE_TAP } from '@/components/sidebar-row-style';
import { cn } from '@/lib/utils';

/**
 * Ticket #1273 item 6 — the SPACES tier's + menu: "New space", "From template" and "New group", the three ways to add to the
 * Spaces list. They were two full-width rows under the tree plus a bare + that only made a group, so the tree carried
 * chrome the prototype keeps in the tier header. One control, one menu, built on the shared DropdownMenu (keyboard: Enter or
 * Space opens it, arrows move, Escape closes and returns focus to the +).
 *
 * WHO SEES IT is the caller's call and is unchanged: the caller renders this only for a person who could already create a
 * space (`canEdit`), exactly the gate the three old controls shared. A viewer or guest never had them and still has no +.
 *
 * "New group" opens its naming dialog from a menu item: the dialog is controlled here and sits OUTSIDE the menu content, so
 * closing the menu on select does not unmount it.
 */
export function SidebarSpacesAddMenu({
  creatingSpace,
  onNewSpace,
  onFromTemplate,
  onNewGroup,
}: {
  creatingSpace?: boolean;
  onNewSpace: () => void;
  onFromTemplate: () => void;
  onNewGroup: (name: string) => void;
}) {
  const [groupOpen, setGroupOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <>
      <DropdownMenu>
        <Tooltip label="Add to Spaces">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add to Spaces"
              className={cn('rounded p-0.5 text-faint hover:bg-hover hover:text-muted aria-expanded:text-ink', PHONE_TAP)}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem disabled={creatingSpace} onSelect={onNewSpace}>
            <Plus className="h-3.5 w-3.5 text-muted" /> New space
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFromTemplate}>
            <LayoutTemplate className="h-3.5 w-3.5 text-muted" /> From template
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setGroupOpen(true)}>
            <FolderPlus className="h-3.5 w-3.5 text-muted" /> New group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent title="New group" unsaved>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) onNewGroup(name.trim());
              setName('');
              setGroupOpen(false);
            }}
          >
            <Input autoFocus placeholder="e.g. Client Work" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary" size="sm">Cancel</Button>
              </DialogClose>
              <Button type="submit" size="sm" disabled={!name.trim()}>Create</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
