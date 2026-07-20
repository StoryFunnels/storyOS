'use client';

import { useMemo, useState } from 'react';
import { OPTION_COLORS } from '@/components/table-view/cells';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ICON_BY_NAME, ICON_CATEGORIES, ICON_SET, ICON_SET_PREFIX, type IconCategory, isSetIconRef, setIconName } from './icon-set';

export const COLOR_NAMES = Object.keys(OPTION_COLORS);

/**
 * Icon & background picker (MN-044, MN-208, #251): the curated StoryOS SVG
 * set with category browse + search, and a fixed background-colour palette.
 * A live preview shows the icon on its background. Databases and spaces store
 * the result in their existing `icon`/`color` columns.
 *
 * #251 retired emoji as a picker option — this only ever writes `set:<name>`
 * refs now. A legacy emoji value can still be *shown* here (IconPreview below
 * renders through EntityIcon, which tolerates it), just not re-selected.
 */
export function IconColorPicker({
  icon,
  color,
  onChange,
}: {
  icon: string | null;
  color: string | null;
  onChange: (patch: { icon?: string | null; color?: string | null }) => void;
}) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<IconCategory | 'all'>('all');
  const q = query.trim().toLowerCase();

  const icons = useMemo(() => {
    return ICON_SET.filter((d) => {
      if (cat !== 'all' && !d.categories.includes(cat)) return false;
      if (!q) return true;
      return d.name.includes(q) || d.keywords.includes(q);
    });
  }, [cat, q]);

  function pickIcon(name: string) {
    onChange({ icon: `${ICON_SET_PREFIX}${name}` });
  }

  return (
    <div className="flex w-72 flex-col gap-2">
      <div className="flex items-center gap-2">
        <IconPreview icon={icon} color={color} />
        <p className="flex-1 text-[12px] font-medium text-muted">Icon</p>
      </div>

      <Input
        autoFocus
        placeholder="Search icons…"
        className="h-8"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />

      {!q && (
        <div className="flex flex-wrap gap-1">
          <CatChip active={cat === 'all'} onClick={() => setCat('all')}>
            All
          </CatChip>
          {ICON_CATEGORIES.map((c) => (
            <CatChip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)}>
              {c.label}
            </CatChip>
          ))}
        </div>
      )}
      <div className="max-h-40 overflow-y-auto">
        <div className="grid grid-cols-8 gap-0.5">
          {icons.map((d) => {
            const selected = setIconName(icon) === d.name;
            return (
              <button
                key={d.name}
                type="button"
                title={d.name.replace(/-/g, ' ')}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded hover:bg-hover',
                  selected && 'bg-accent-soft ring-1 ring-[var(--accent)]',
                )}
                onClick={() => pickIcon(d.name)}
                style={color ? { color: OPTION_COLORS[color] } : undefined}
              >
                <d.Icon className="h-4 w-4" strokeWidth={2} />
              </button>
            );
          })}
          {icons.length === 0 && <p className="col-span-8 p-2 text-[12px] text-muted">No matches.</p>}
        </div>
      </div>

      <div className="border-t border-border-default pt-2">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Background</p>
        <div className="flex gap-1">
          {COLOR_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded hover:bg-hover',
                c === color && 'ring-1 ring-[var(--accent)]',
              )}
              onClick={() => onChange({ color: c === color ? null : c })}
            >
              <span className="h-4 w-4 rounded-full" style={{ backgroundColor: OPTION_COLORS[c] }} />
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="self-start text-[12px] text-muted underline-offset-2 hover:underline"
        onClick={() => onChange({ icon: null, color: null })}
      >
        Remove icon & color
      </button>
    </div>
  );
}

function CatChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px]',
        active ? 'bg-accent-soft font-medium text-ink' : 'text-muted hover:bg-hover',
      )}
    >
      {children}
    </button>
  );
}

/** Large square preview of the icon on its background (the header look). */
function IconPreview({ icon, color }: { icon: string | null; color: string | null }) {
  const hex = color ? OPTION_COLORS[color] : null;
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-border-default"
      style={hex ? { backgroundColor: `${hex}22`, color: hex } : undefined}
    >
      <EntityIcon icon={icon} color={color} size={20} fallback={<span className="text-faint">?</span>} />
    </div>
  );
}

/**
 * EntityIcon on its background chip — the larger "header" look. Shows a soft
 * tinted square when a colour is set; otherwise just the centred icon.
 */
export function EntityIconChip({
  icon,
  color,
  size = 16,
  fallback,
  className,
}: {
  icon?: string | null;
  color?: string | null;
  size?: number;
  fallback: React.ReactNode;
  className?: string;
}) {
  const hex = color ? OPTION_COLORS[color] : null;
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-[6px]', className)}
      style={hex ? { backgroundColor: `${hex}22` } : undefined}
    >
      <EntityIcon icon={icon} color={color} size={size} fallback={fallback} />
    </span>
  );
}

/**
 * Sidebar/database glyph. Renders, in order: a curated set icon (`set:<name>`,
 * tinted by color), a legacy emoji/text string, or the fallback glyph tinted
 * by color. Set icons scale crisply to any `size`.
 *
 * #251 retired emoji from the picker and backfilled existing values to `set:`
 * refs, but this branch stays: a stray emoji can still arrive from an older
 * MCP client, and the tile must render it rather than go blank.
 */
export function EntityIcon({
  icon,
  color,
  fallback,
  className,
  size,
}: {
  icon?: string | null;
  color?: string | null;
  fallback: React.ReactNode;
  className?: string;
  /** Pixel size for curated set icons (defaults to the surrounding font size). */
  size?: number;
}) {
  const setName = setIconName(icon);
  if (setName) {
    const Icon = ICON_BY_NAME[setName]!;
    return (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', className)}
        style={color ? { color: OPTION_COLORS[color] } : undefined}
      >
        <Icon
          strokeWidth={2}
          className={size ? undefined : 'h-[1em] w-[1em]'}
          size={size}
        />
      </span>
    );
  }
  // A `set:` ref that failed to resolve above (a stale/unknown curated name —
  // e.g. from data predating a set rename) is NOT a legacy emoji glyph and
  // must never render as visible text; fall through to `fallback` instead.
  if (icon && !isSetIconRef(icon)) {
    return (
      <span
        className={cn(
          'inline-flex w-4 shrink-0 items-center justify-center text-[14px] leading-none',
          className,
        )}
        style={size ? { fontSize: size } : undefined}
      >
        {icon}
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex shrink-0 items-center', className)}
      style={color ? { color: OPTION_COLORS[color] } : undefined}
    >
      {fallback}
    </span>
  );
}
