'use client';

import { useState } from 'react';
import { DESCRIPTION_MAX } from '@storyos/schemas';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * THE description editor (#457). One component for all three levels — workspace,
 * space and database — deliberately, and it is the only place in the web app that
 * knows how a description is written.
 *
 * #400 already made this choice on the API side: `packages/schemas/src/descriptions.ts`
 * carries ONE `descriptionSchema` for all three levels, with a comment saying in so
 * many words that three copies of `z.string().max(200)` is the shape that drifts —
 * one gains a trim, one gains a longer cap, and the product ends up with three
 * different ideas of what a description is. The UI must not undo that on the way
 * back out. Rename is already implemented twice in `sidebar.tsx` (inline, once for
 * a space and once for a database), which is exactly the path that would have given
 * this feature two or three copies with their own caps and their own trimming; this
 * codebase has shipped one concept as several drifting copies at least six times
 * (#375, #380, #383, #399, #408, #422).
 *
 * Two rules this component does NOT own, and must not re-implement:
 *
 *   - **The cap is `DESCRIPTION_MAX`**, imported from the schema package. Not a
 *     literal 200 typed here. If the server's bound moves, this moves with it.
 *   - **Normalisation is the server's** (`normalizeDescription`, same file):
 *     whitespace collapsing, trimming, and turning an emptied box into `null`.
 *     This component sends what the person typed and lets the one choke point
 *     decide. The single exception is the empty case below, which it must handle
 *     itself because the difference is `null` vs. a string at the API boundary.
 *
 * **Clearing means `null`, never `''`.** An emptied box sends `null` so the
 * description is removed rather than stored as an empty string. `''` and absent
 * would render identically but be two different states — #305's rule, that
 * unconfigured is not invalid, and also that it should not be two things.
 */
export function DescriptionDialogContent({
  /** What is being described — "Issues", "Product", the workspace name. Shown in
   *  the dialog title so a person opening it from a menu knows which thing. */
  name,
  /** The level's noun, for the helper line: "database", "space", "workspace". */
  noun,
  /** Current value; `null` for an undescribed thing. */
  initial,
  /** Receives `null` when the box was emptied, otherwise the raw typed string. */
  onSave,
}: {
  name: string;
  noun: string;
  initial: string | null | undefined;
  onSave: (description: string | null) => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  // Length is measured on what the server will actually store, so the counter does
  // not tell someone they are over the limit because of a trailing newline the
  // server is about to collapse away. Deliberately mirrors `normalizeDescription`'s
  // collapse rule rather than re-deriving a different one.
  const measured = value.replace(/\s+/g, ' ').trim();
  const over = measured.length > DESCRIPTION_MAX;
  const remaining = DESCRIPTION_MAX - measured.length;

  return (
    <DialogContent title={`Describe ${name}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (over) return;
          // Empty box → null (remove it), never `''`. See the note above.
          onSave(measured === '' ? null : value);
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted">
            One line saying what this {noun} is for. Shown to anyone who opens it.
          </span>
          <textarea
            autoFocus
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            // No `maxLength`: a hard cap silently swallows the tail of a pasted
            // sentence, and the person never learns why. AC 7 asks for the limit
            // to be visible and exceeding it reported, not prevented invisibly.
            className={cn(
              'w-full resize-none rounded-[var(--radius-control)] border bg-card px-2 py-1.5 text-[13px] text-ink',
              over ? 'border-error' : 'border-border-default',
            )}
            placeholder={`What is this ${noun} for?`}
          />
        </label>
        <div className="flex items-center gap-2">
          <span className={cn('text-[12px] tabular-nums', over ? 'text-error' : 'text-faint')}>
            {over
              ? `${measured.length - DESCRIPTION_MAX} over the ${DESCRIPTION_MAX}-character limit`
              : `${remaining} left`}
          </span>
          <div className="ml-auto flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={over}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  );
}
