'use client';

import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * #724 (Vera's post-merge finding) — a real custom control, not a bare native
 * `<input type="file">` styled with Tailwind's `file:` variant. The `file:`
 * classes compile correctly, but a native file input's button-to-text layout
 * and box model are governed by browser/OS chrome CSS only partially reaches
 * — it read as visually inconsistent next to every other field on the form,
 * which goes through this component system, and could render differently
 * again across browsers/platforms.
 *
 * The real `<input>` is layered directly over the decorative `Button` at
 * `opacity-0`, not `display:none` or moved off-screen: a hidden-but-rendered
 * input keeps native keyboard focus, Enter/Space activation, and constraint
 * validation (`required`) all working exactly as they would on a visible
 * input — a `display:none` input is barred from receiving the click a
 * `ref.click()` proxy would need, and can silently block submission when
 * required, since the browser can't scroll a non-rendered element into view
 * to show its validation message.
 */
export function FileInput({
  file,
  onChange,
  required,
  className,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="relative">
        <Button type="button" variant="secondary" size="sm" tabIndex={-1} aria-hidden className="pointer-events-none">
          Choose file
        </Button>
        {/* #724 — keyed so a cleared file doesn't leave the native input's own
            internal value pointing at a file this control no longer has. */}
        <input
          key={file ? file.name + file.lastModified : 'empty'}
          type="file"
          required={required}
          onChange={(e) => onChange(e.target.files?.[0] ?? null)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </div>
      <span className={cn('flex-1 truncate text-[13px]', file ? 'text-ink' : 'text-muted')}>
        {file ? file.name : 'No file chosen'}
      </span>
      {file && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[12px] text-muted underline hover:text-ink"
        >
          Remove
        </button>
      )}
    </div>
  );
}
