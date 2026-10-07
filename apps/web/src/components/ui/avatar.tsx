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

function initials(name: string, single: boolean): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0]!.toUpperCase();
  if (single || words.length === 1) return first;
  return first + words[words.length - 1]![0]!.toUpperCase();
}

const SIZES = { 16: 'h-4 w-4 text-[8px]', 20: 'h-5 w-5 text-[9px]', 24: 'h-6 w-6 text-micro', 32: 'h-8 w-8 text-label', 64: 'h-16 w-16 text-[22px]' } as const;

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
        'option-tint inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        SIZES[size],
        className,
      )}
      /* #638 — the third instance of the same theme-blind pairing (OptionChip and
         icon-picker's IconPreview are the others): an 18%-alpha wash of the
         palette colour with that colour at full strength as the initials. The
         wash follows the theme, the ink did not, so 88 of 90 colour/surface/
         theme combinations failed AA — worst indigo 2.37 on a dark card. Shares
         OptionChip's derivation rather than growing a fourth mechanism. */
      style={
        { backgroundColor: `${color}2E`, ['--option-color' as string]: color } as CSSProperties
      }
    >
      {initials(name, size <= 16)}
    </span>
  );
}
