'use client';

import { cn } from '@/lib/utils';

/**
 * One result row in an entity picker (#169), Fibery-parity layout:
 *
 *   [icon]  Title                         #id
 *           space › database
 *
 * Kept deliberately presentational and dependency-light (just `cn`) so the
 * exact same row look is reused across surfaces — the rich-text @/# mention
 * pickers here, and the relation Add/Link picker (#173) next — without either
 * pulling in the other's data-fetching. Callers pass fully-formed pieces:
 * an already-built `icon` node (avatar / db marker / emoji), the `title`, an
 * optional `breadcrumb` subtext, and an optional `idChip` (rendered as the
 * faint `#<id>` record-chip look). `active` drives the keyboard-highlight;
 * hover highlights on its own.
 */
export function EntityPickerRow({
  icon,
  title,
  breadcrumb,
  idChip,
  active = false,
  onClick,
  onMouseEnter,
}: {
  icon?: React.ReactNode;
  title: string;
  breadcrumb?: string | null;
  idChip?: string | number | null;
  active?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[13px] text-ink transition-colors',
        active ? 'bg-accent-soft' : 'hover:bg-hover',
      )}
    >
      {icon != null && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[13px] text-muted">
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium leading-tight">{title || 'Untitled'}</span>
        {breadcrumb && (
          <span className="truncate text-[11px] leading-tight text-muted">{breadcrumb}</span>
        )}
      </span>
      {idChip != null && idChip !== '' && (
        <span className="ml-2 shrink-0 tabular-nums text-[11px] text-faint">#{idChip}</span>
      )}
    </button>
  );
}
