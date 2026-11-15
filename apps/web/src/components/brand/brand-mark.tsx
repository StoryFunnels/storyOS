/**
 * Ticket #1302 — the StoryOS mark, themed. `public/brand/mark.svg` is a fixed navy tile (#0F1729): on the dark card (#171c26) that is
 * about 1.1:1, so the tile vanished and only the floating bars were left. The tile and its 2px stroke read from `--brand-mark-tile`
 * and `--brand-mark-stroke`, set per theme in globals.css: light is unchanged (navy tile, stroke the same colour so it is invisible);
 * dark is #232B3C with a #3A4458 stroke, the values in the design prototype. The bars (gold and cream) are fixed and clear 3:1 on
 * the dark card. `brand-mark.unit.test.ts` computes the ratios from the real tokens.
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
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="13"
        strokeWidth="2"
        style={{ fill: 'var(--brand-mark-tile)', stroke: 'var(--brand-mark-stroke)' }}
      />
      <rect x="14" y="15" width="28" height="9" rx="4.5" fill="#D4A017" />
      <rect x="22" y="27.5" width="28" height="9" rx="4.5" fill="#F5E4B8" />
      <rect x="14" y="40" width="28" height="9" rx="4.5" fill="#D4A017" />
    </svg>
  );
}
