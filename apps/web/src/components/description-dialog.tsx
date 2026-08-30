'use client';

import { useState } from 'react';
import { describeDraft } from '@/lib/description-draft';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * The description editor as a DIALOG (#457) — used by the database and space
 * context menus, which is where those two levels already have a menu to hang it
 * on. The workspace has no such menu, so its editor is an inline field on the
 * Settings → General page.
 *
 * That difference is CHROME, and it is allowed. What is not allowed is the rules
 * differing, and in the first cut of this ticket they did: both surfaces
 * re-derived the same trim, over-limit test, clear-to-null rule and counter
 * wording. Verification failed on exactly that (criterion 6), correctly — the cap
 * was shared and nothing else was. All four now come from `describeDraft`
 * (`lib/description-draft.ts`), which is the one web-side definition, and neither
 * surface computes any of them.
 *
 * #400 made the same choice on the API side: `packages/schemas/src/descriptions.ts`
 * carries ONE `descriptionSchema` for all three levels, with a comment saying in so
 * many words that three copies of `z.string().max(200)` is the shape that drifts.
 * This is that rule holding on the way back out.
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
  // #457 — the trim, the over-limit test, the clear-to-null rule and the counter
  // wording all come from `describeDraft`, the ONE web-side definition. This file
  // used to re-derive them, and so did the workspace settings page; they were
  // identical, which is how these things always start.
  const draft = describeDraft(value);

  return (
    <DialogContent title={`Describe ${name}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.over) return;
          onSave(draft.value);
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
              draft.over ? 'border-error' : 'border-border-default',
            )}
            placeholder={`What is this ${noun} for?`}
          />
        </label>
        <div className="flex items-center gap-2">
          <span className={cn('text-[12px] tabular-nums', draft.over ? 'text-error' : 'text-faint')}>
            {draft.hint}
          </span>
          <div className="ml-auto flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={draft.over}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  );
}
