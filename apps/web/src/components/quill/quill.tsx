import { useId } from 'react';
import { cn } from '@/lib/utils';
import { QUILL_POSES, type QuillPose } from './quill-poses';

/**
 * #1253 — Quill, the raven from the kitchen brand world, as one shared component. Every placement (pack install, run outcomes,
 * empty states, the 404) renders HER through this and never copies her styles, so a pose cannot drift between screens.
 *
 * Rules that live here so no caller has to remember them:
 *  - Decorative, always: `aria-hidden`. The real words (the error, the state, the action) are in the DOM beside her and come first.
 *  - No gold. Her art is ink, paper and steel (see quill-poses.ts); gold means an agent is acting (#831).
 *  - The caption is her ONE line, in italic Instrument Serif. Plain product words belong in the UI copy, not in the caption.
 *  - Motion is a CSS class gated on `prefers-reduced-motion: no-preference` (globals.css), so a still pose is the default.
 */
export function QuillArt({ pose, size, className }: { pose: QuillPose; size: number; className?: string }) {
  // The filters are referenced by id; two Quills on one page must not share one.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg
      className={cn('quill-art block', className)}
      viewBox="0 0 220 214"
      width={size}
      height={Math.round((size * 214) / 220)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id={`qr-${uid}`} x="-8%" y="-8%" width="116%" height="116%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="11" />
          <feDisplacementMap in="SourceGraphic" scale="1.8" />
        </filter>
        <filter id={`qe-${uid}`} x="-10%" y="-10%" width="120%" height="120%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="1.6" result="d" />
          <feFlood style={{ floodColor: 'var(--q-edge)' }} />
          <feComposite in2="d" operator="in" result="o" />
          <feMerge>
            <feMergeNode in="o" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter={`url(#qe-${uid})`}>
        <g
          filter={`url(#qr-${uid})`}
          strokeLinecap="round"
          strokeLinejoin="round"
          dangerouslySetInnerHTML={{ __html: QUILL_POSES[pose] }}
        />
      </g>
    </svg>
  );
}

/** Her caption: one remark, italic Instrument Serif, muted. */
const CAPTION = 'font-[family-name:var(--font-quill)] italic leading-[1.1] text-muted';

/** Quill standing over her caption (the install dialog, the toast, the empty states, the 404). */
export function Quill({
  pose,
  size,
  caption,
  animate,
  className,
  captionClassName,
}: {
  pose: QuillPose;
  size: number;
  caption?: string;
  /** Waiting states only: a slow bob. Still for everyone who asked for reduced motion. */
  animate?: boolean;
  className?: string;
  captionClassName?: string;
}) {
  return (
    <figure className={cn('m-0 flex shrink-0 flex-col items-center gap-1', className)} aria-hidden="true" data-testid="quill" data-pose={pose}>
      <QuillArt pose={pose} size={size} className={animate ? 'quill-bob' : undefined} />
      {caption && <figcaption className={cn(CAPTION, 'max-w-[120px] text-center text-[15px]', captionClassName)}>{caption}</figcaption>}
    </figure>
  );
}

/** Quill BESIDE a run's state pill: 30px, her line to the right of her, on one line. Never instead of the pill. */
export function QuillBeside({ pose, caption }: { pose: QuillPose; caption: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" aria-hidden="true" data-testid="quill" data-pose={pose}>
      <QuillArt pose={pose} size={30} />
      <span className={cn(CAPTION, 'whitespace-nowrap text-[15px]')}>{caption}</span>
    </span>
  );
}
