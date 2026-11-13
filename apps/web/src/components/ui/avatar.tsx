'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
// Leaf module, not cells.tsx: this value is read at MODULE SCOPE below, and
// importing it from cells.tsx forms a cycle that leaves it in its temporal dead
// zone on any route where cells.tsx evaluates first (see option-colors.ts).
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import { cn } from '@/lib/utils';

const COLOR_KEYS = Object.keys(OPTION_COLORS);

/** Stable per-user palette color: hash the id, not the name (MN-045). */
function colorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return OPTION_COLORS[COLOR_KEYS[Math.abs(hash) % COLOR_KEYS.length]!]!;
}

/** How far toward black the palette colour is mixed so white initials reach 4.5:1 on every one of them (ticket #1277 item 4). */
export const AVATAR_DARKEN = 0.15;

/** The avatar's solid fill: the palette colour, a notch darker. A pure function so the test can recompute the contrast. */
export function avatarFill(color: string): string {
  return `color-mix(in srgb, ${color} ${Math.round((1 - AVATAR_DARKEN) * 100)}%, black)`;
}

function initials(name: string, single: boolean): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0]!.toUpperCase();
  if (single || words.length === 1) return first;
  return first + words[words.length - 1]![0]!.toUpperCase();
}

const SIZES = { 16: 'h-4 w-4 text-[8px]', 18: 'h-[18px] w-[18px] text-[10px]', 20: 'h-5 w-5 text-[9px]', 24: 'h-6 w-6 text-micro', 32: 'h-8 w-8 text-label', 64: 'h-16 w-16 text-[22px]' } as const;

export function Avatar({
  userId,
  name,
  image,
  size = 20,
  className,
}: {
  userId: string;
  name: string;
  image?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const color = colorFor(userId);

  if (image && !broken) {
    return (
      <img
        src={image}
        alt={name}
        title={name}
        onError={() => setBroken(true)}
        className={cn('shrink-0 rounded-full object-cover', SIZES[size], className)}
      />
    );
  }
  return (
    <span
      title={name}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-[-0.05em] text-white',
        SIZES[size],
        className,
      )}
      /* Ticket #1277 item 4: ONE avatar everywhere, the design's: a SOLID per-person colour with white initials (it was an
         18% wash with the colour as the ink, #638). White on the raw palette fails 4.5:1 for gold, orange and teal (3.6 to
         4.2), so the fill is the palette colour mixed 15% toward black: the worst of all fifteen is 4.8:1. The mix is one
         constant (AVATAR_DARKEN) and avatar.unit.test.ts recomputes the ratio for every palette colour. */
      style={{ backgroundColor: avatarFill(color) } as CSSProperties}
    >
      {initials(name, size <= 16)}
    </span>
  );
}
