import type { LucideIcon } from 'lucide-react';
import { BarChart3, Check, Copy, Download, FolderInput, Link2, Lock, Pencil, Share2, Star, Trash2 } from 'lucide-react';

/**
 * #964 — THE VIEW MENU. One list, three doors: the toolbar ⋯, the sidebar row's ⋯, and the tab's ⋯ /
 * right-click / long-press. This file is the only place the list is decided, so a door cannot grow
 * or lose an item on its own (the drift #383/#389 fixed for sidebar rows, applied to views).
 *
 * Doors differ only in WHAT THEY CAN SUPPLY, never in the list:
 * - `onAddWidget` and `exportHref` are the TOOLBAR door's (a summary widget and a CSV are about the
 *   rows on screen); the other two doors do not pass them.
 * - Everything else is offered by every door that can run it.
 *
 * "Pin to tabs" / "Unpin from tabs" (#966) is per-viewer state (ADR-0019), so it is offered to everyone who can see the
 * view, not only editors, and never for a PERSONAL view (the strip draws shared views only).
 * There is no "Save as new view": views auto-save (MN-152), so there is never an unsaved state.
 */
export type ViewMenuId =
  | 'rename'
  | 'duplicate'
  | 'default'
  | 'pin'
  | 'link'
  | 'share'
  | 'personal'
  | 'move'
  | 'widget'
  | 'csv'
  | 'delete';

export interface ViewMenuItem {
  /** Unique within one menu; `move` entries are `move:<folderId|root>`. */
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  /** A navigation (CSV download), rendered as a real link. */
  href?: string;
  danger?: boolean;
  /** Shown but inert, with this reason as its title (never a silently missing item). */
  disabledReason?: string;
  separatorBefore?: boolean;
}

export interface ViewMenuTarget {
  name: string;
  isDefault: boolean;
  /** #966 — in THIS viewer's tab strip. Undefined when the door cannot tell (then the item reads "Pin to tabs"). */
  pinned?: boolean;
  /** A personal view: private to its owner, never shared and never copied to My Space. */
  personal: boolean;
}

export interface ViewMenuHandlers {
  /** Editors only. Without it the menu is just "Copy link". */
  canManage: boolean;
  /** False when this is the database's only view. */
  canDelete: boolean;
  onRename?: () => void;
  onDuplicate?: () => void;
  onSetDefault?: () => void;
  /** #966 — pin or unpin for THIS viewer; receives the outcome the label promised. */
  onSetPinned?: (wanted: boolean) => void;
  onCopyLink?: () => void;
  /** Absent for a view type the public page cannot render. */
  onShare?: () => void;
  onCopyToPersonal?: () => void;
  /** One entry per place it can go ("Move to Marketing", "Move back under its database"). */
  moves?: Array<{ id: string; label: string; onSelect: () => void }>;
  /** Toolbar door only. */
  onAddWidget?: () => void;
  /** Toolbar door only. */
  exportHref?: string;
  onDelete?: () => void;
}

export function buildViewMenu(target: ViewMenuTarget, h: ViewMenuHandlers): ViewMenuItem[] {
  const items: ViewMenuItem[] = [];
  const add = (item: ViewMenuItem | false | undefined) => {
    if (item) items.push(item);
  };

  if (h.canManage) {
    add(h.onRename && { id: 'rename', label: 'Rename', icon: Pencil, onSelect: h.onRename });
    add(h.onDuplicate && { id: 'duplicate', label: 'Duplicate', icon: Copy, onSelect: h.onDuplicate });
    add(
      !target.isDefault &&
        h.onSetDefault && { id: 'default', label: 'Set as default', icon: Check, onSelect: h.onSetDefault },
    );
  }
  // Per-viewer, so outside the editors-only block: a viewer pins for themself.
  add(
    !target.personal &&
      h.onSetPinned && {
        id: 'pin',
        label: target.pinned ? 'Unpin from tabs' : 'Pin to tabs',
        icon: Star,
        onSelect: () => h.onSetPinned!(!target.pinned),
      },
  );
  add(h.onCopyLink && { id: 'link', label: 'Copy link', icon: Link2, onSelect: h.onCopyLink });
  if (h.canManage) {
    // #527 — never for a PERSONAL view: it is a private window onto shared data.
    add(!target.personal && h.onShare && { id: 'share', label: 'Share…', icon: Share2, onSelect: h.onShare });
    // #293 — fork a SHARED view into a private copy, never synced back.
    add(
      !target.personal &&
        h.onCopyToPersonal && { id: 'personal', label: 'Copy to My Space', icon: Lock, onSelect: h.onCopyToPersonal },
    );
    h.moves?.forEach((m, i) =>
      add({ id: `move:${m.id}`, label: m.label, icon: FolderInput, onSelect: m.onSelect, separatorBefore: i === 0 }),
    );
    add(h.onAddWidget && { id: 'widget', label: 'Add summary widget', icon: BarChart3, onSelect: h.onAddWidget, separatorBefore: true });
  }
  add(h.exportHref ? { id: 'csv', label: 'Export CSV', icon: Download, href: h.exportHref } : undefined);
  if (h.canManage) {
    add(
      h.onDelete && {
        id: 'delete',
        label: 'Delete view',
        icon: Trash2,
        danger: true,
        onSelect: h.onDelete,
        disabledReason: h.canDelete ? undefined : 'A database keeps at least one view',
        separatorBefore: true,
      },
    );
  }
  return items;
}
