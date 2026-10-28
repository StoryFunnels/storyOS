import type { StateCategory } from '@storyos/schemas';
import { cn } from '@/lib/utils';

/**
 * #1115 — a state's glyph, drawn the way an issue tracker draws it: a dashed ring for
 * backlog, an empty ring for not started, a ring with a pie for in progress (the
 * pie is the percent when the caller has one, a half otherwise), a filled disc
 * with a tick for done and with a cross for canceled. One colour — the option's
 * — so a group header and the chips under it agree. Decorative: the label or
 * the number beside it carries the meaning.
 */
/** What the glyph draws for a category: a disc with a tick or a cross, or a ring — dashed for backlog — with a pie (0–1) inside while in progress. */
export function glyphShape(category: StateCategory | null | undefined, percent?: number): { kind: 'tick' | 'cross' | 'dashed' | 'ring'; pie: number } {
  if (category === 'completed') return { kind: 'tick', pie: 0 };
  if (category === 'canceled') return { kind: 'cross', pie: 0 };
  const pie = category === 'started' || category == null ? Math.min(1, Math.max(0, (percent ?? 50) / 100)) : 0;
  return { kind: category === 'backlog' ? 'dashed' : 'ring', pie };
}

export function StateGlyph({
  category,
  color,
  percent,
  size = 14,
  className,
}: {
  category?: StateCategory | null;
  color?: string;
  percent?: number;
  size?: number;
  className?: string;
}) {
  const c = size / 2;
  const r = c - 1;
  const stroke = color ?? 'currentColor';
  const svg = { width: size, height: size, viewBox: `0 0 ${size} ${size}`, className: cn('shrink-0', className), 'aria-hidden': true as const };
  const shape = glyphShape(category, percent);
  if (shape.kind === 'tick' || shape.kind === 'cross') {
    const d =
      shape.kind === 'tick'
        ? `M${c - r * 0.5} ${c + r * 0.05} L${c - r * 0.12} ${c + r * 0.42} L${c + r * 0.52} ${c - r * 0.38}`
        : `M${c - r * 0.4} ${c - r * 0.4} L${c + r * 0.4} ${c + r * 0.4} M${c + r * 0.4} ${c - r * 0.4} L${c - r * 0.4} ${c + r * 0.4}`;
    return (
      <svg {...svg}>
        <circle cx={c} cy={c} r={r} fill={stroke} />
        <path d={d} fill="none" stroke="var(--bg-app)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const pie = shape.pie;
  const ri = r - 2.5;
  const a = 2 * Math.PI * pie;
  const wedge =
    pie >= 1
      ? undefined
      : `M${c} ${c} L${c} ${c - ri} A${ri} ${ri} 0 ${pie > 0.5 ? 1 : 0} 1 ${c + ri * Math.sin(a)} ${c - ri * Math.cos(a)} Z`;
  return (
    <svg {...svg}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray={shape.kind === 'dashed' ? '2 2' : undefined} />
      {pie >= 1 && <circle cx={c} cy={c} r={ri} fill={stroke} />}
      {pie > 0 && pie < 1 && <path d={wedge} fill={stroke} />}
    </svg>
  );
}
