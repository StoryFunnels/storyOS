import type { LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * #628 — a field's label is the SAME step as the field: `text-prose` (14px).
 *
 * It was `text-body` (13px) against an input on Tailwind's `text-sm` (14px), so
 * every form in the product had a label a pixel off its own field, with a
 * different leading ratio too (1.5 against text-sm's 1.43). Two type scales
 * disagreeing inside one component pair, which is precisely what the role-named
 * scale exists to stop.
 *
 * THIS GREW THE LABEL RATHER THAN SHRINKING THE FIELD, which reverses what I
 * recommended on the ticket. The reasoning I had was a 550-to-127 usage majority
 * for 13px — but that counts ALL app text, and the population that matters here
 * is controls, where 14px is what every Input and Button already ships. Growing
 * 105 labels beats shrinking 313 controls: it moves a third as many pixels,
 * toward design-system.md's stated "base 14px for UI chrome" rather than away
 * from it, and it never makes user-entered text smaller. Input text is content
 * the user is composing and re-reading; a label is read once.
 */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-prose font-medium text-ink-secondary', className)}
      {...props}
    />
  );
}
