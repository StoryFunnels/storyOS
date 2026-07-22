import { OPTION_COLORS } from '@storyos/schemas';

/**
 * Stable per-database palette color (MN-299): the persisted value if the
 * database has one, else a deterministic hash-of-id fallback so databases
 * created before auto-color-assignment existed still resolve to *something*
 * sensible — without a backfill migration (one drizzle migration was already
 * in flight repo-wide at implementation time). Read-time only, never
 * persisted, so it never fights the manual-override path
 * (DatabasesService.update() via the icon-picker swatch UI). Mirrors the
 * id-hash pattern already used for user avatar colors
 * (apps/web/src/components/ui/avatar.tsx).
 */
export function resolveDatabaseColor(id: string, color: string | null): string {
  if (color) return color;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return OPTION_COLORS[Math.abs(hash) % OPTION_COLORS.length]!;
}

/** Random palette color assigned to a freshly created database (MN-299), unless
 * the caller explicitly provided one. */
export function randomDatabaseColor(): string {
  return OPTION_COLORS[Math.floor(Math.random() * OPTION_COLORS.length)]!;
}
