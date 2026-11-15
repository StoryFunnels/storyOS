import { cn } from '@/lib/utils';
import { chipVariants } from '@/components/ui/chip';
import { isEntityToken } from '@/lib/entity-color';

/*
 * Ticket #1287 - the relation chip and the database marker, moved here VERBATIM from relation-cell.tsx so a surface that only draws a
 * chip (the Settings audit log) does not import the relation pickers, their popovers and their controls with it. relation-cell.tsx
 * re-exports both, so every existing import keeps working and there is still exactly one chip.
 */

/** Same hex values as cells.tsx's OPTION_COLORS — kept as a small local copy
 * (mirrors nextOptionColor's comment there) so this leaf module doesn't
 * import from cells.tsx, which already imports RelationChips from here. */
const DB_MARKER_COLORS: Record<string, string> = {
  gray: '#64748B',
  brown: '#9C6B43',
  gold: '#B7791F',
  orange: '#E4551F',
  red: '#DC2626',
  pink: '#DB2777',
  purple: '#7C3AED',
  blue: '#2563EB',
  teal: '#0D9488',
  green: '#15803D',
  lime: '#4D7C0F',
  cyan: '#0E7490',
  indigo: '#4F46E5',
  magenta: '#A21CAF',
  rose: '#E11D48',
};

/**
 * Small filled "database" cylinder marker (MN-299): renders in the target
 * database's color immediately before a relation chip's title, so users can
 * tell which database a link points to at a glance — table cells, board
 * cards, the relation editor's own pills, record-detail chips, and
 * related-records panel rows all render this SAME component (never
 * reimplemented per site). Renders nothing if no color is known.
 */
export function DbColorMarker({ color, className }: { color?: string | null; className?: string }) {
  if (!color) return null;
  // #1001 — a default-colour token (`c1`..`c8`) is theme-aware; a chosen palette name keeps its fixed hex.
  const hex = isEntityToken(color) ? `var(--${color})` : (DB_MARKER_COLORS[color] ?? DB_MARKER_COLORS.gray!);
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className={cn('shrink-0', className)}>
      <path d="M1 3.2v5.6C1 10 3.2 11 6 11s5-1 5-2.2V3.2" fill={hex} />
      <ellipse cx="6" cy="3.2" rx="5" ry="2.2" fill={hex} />
    </svg>
  );
}

/**
 * Relation-entity chip (#281, "solid mini-tag" direction's outline half): the
 * deliberate visual inverse of OptionChip (cells.tsx) — same 4px-radius shape, but
 * outline-only in a neutral/faint border with normal-case body-size text and no
 * fill or letter-spacing, so a reference to another record (Blocked By, Blocker
 * for, board relation groups, …) is never confused with a category value.
 *
 * #293: when `href` is given, the chip is a real link to the record's own page
 * (new tab — full split-screen is #282's job). Kept optional so call sites that
 * can't yet supply ws/target-database context (e.g. board cards) render exactly
 * as before.
 */
export function RelationChip({
  title,
  href,
  className,
  color,
  number,
}: {
  title: string;
  href?: string;
  className?: string;
  /** MN-299: target database color for the cylinder marker. */
  color?: string | null;
  /** MN-126: public per-database #id, shown faint before the name so linked
   * records stay identifiable when titles collide or are blank. */
  number?: number | null;
}) {
  /* #533 — the shape and the OUTLINE variant come from the shared chip
     primitive, so the inverse-of-filled relationship is declared in one place
     rather than held by two components happening to differ. `max-w-40
     shrink-0` stays here: it is this surface's layout, not the chip's identity. */
  const shared = cn(chipVariants({ variant: 'reference' }), 'max-w-40 shrink-0', className);
  // Same treatment as the record-page relation rows (#227): faint, tabular #id
  // with a small right margin, rendered only when a number exists.
  const idBadge =
    number != null ? (
      <span className="shrink-0 tabular-nums text-faint">#{number}</span>
    ) : null;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        // The cell/row this chip sits in usually has its own click handling
        // (select the cell, open the record on row click, …) — stop the click
        // there so opening the chip's own link doesn't also fire that.
        onClick={(e) => e.stopPropagation()}
        className={cn(shared, 'hover:border-border-strong hover:bg-hover hover:underline')}
      >
        <DbColorMarker color={color} />
        {idBadge}
        <span className="truncate">{title || 'Untitled'}</span>
      </a>
    );
  }
  return (
    <span className={shared}>
      <DbColorMarker color={color} />
      {idBadge}
      <span className="truncate">{title || 'Untitled'}</span>
    </span>
  );
}
