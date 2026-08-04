import type { LucideIcon } from 'lucide-react';
import { Clock, Hash, ListFilter, Type, UserRound } from 'lucide-react';
import { FIELD_TYPES } from '../table-view/field-dialog-shared';

/** Field-type icon (mirrors the Add Field dialog's type list) — used on filter
 * rows, the Fields menu and pinned chips so a field's type is recognizable at a
 * glance. Falls back for system types that aren't creatable fields. Extracted to
 * its own module so both the view toolbar and the shared Fields menu can share it
 * without a circular import. */
const TYPE_ICON = new Map(FIELD_TYPES.map((t) => [t.value, t.icon]));
const SYSTEM_TYPE_ICON: Record<string, LucideIcon> = {
  title: Type,
  id: Hash,
  created_at: Clock,
  updated_at: Clock,
  created_by: UserRound,
  updated_by: UserRound,
};
export function fieldTypeIcon(type: string): LucideIcon {
  return TYPE_ICON.get(type) ?? SYSTEM_TYPE_ICON[type] ?? ListFilter;
}
