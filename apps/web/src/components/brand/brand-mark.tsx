/**
 * Ticket #1302 — the StoryOS mark, themed. `public/brand/mark.svg` is a fixed navy tile (#0F1729): on the dark card (#171c26) that is
 * about 1.1:1, so the tile vanished and only the floating bars were left. The tile and the middle bar read from `--brand-mark-tile`
 * and `--brand-mark-mid`, set per theme in globals.css (navy tile in light; the cream tile `logo-dark.svg` already uses in dark), so
 * the mark keeps >= 3:1 against the card in both. The gold bars are the brand colour and do not change. `brand-mark.unit.test.ts`
 * computes the ratios from the real tokens.
 */
export function BrandMark({
  className = 'h-8 w-8',
  title = 'StoryOS',
}: {
  className?: string;
  title?: string | null;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      data-brand-mark=""
    >
      <rect width="64" height="64" rx="14" style={{ fill: 'var(--brand-mark-tile)' }} />
      <rect x="14" y="15" width="28" height="9" rx="4.5" fill="#D4A017" />
      <rect
        x="22"
        y="27.5"
        width="28"
        height="9"
        rx="4.5"
        style={{ fill: 'var(--brand-mark-mid)' }}
      />
      <rect x="14" y="40" width="28" height="9" rx="4.5" fill="#D4A017" />
    </svg>
  );
}
