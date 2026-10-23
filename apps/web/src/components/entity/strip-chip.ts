import { createContext, useContext } from 'react';

/**
 * Ticket #1060 — the ONE shape of a value in the record header strip, the prototype's `.pill`: 19px tall, 8px of padding, the
 * app's chip radius, 12px at weight 600. A select, a workflow state and a relation (the Epic) all wear it, so a row of values
 * reads as one kind of thing; the person is the prototype's `.av` (avatar and name) at the same height. An ACTION is not a value
 * and never uses this: it is an app button, set apart.
 *
 * The strip provides this context; the value renderers (OptionChip, the person cell, the relation chip) read it, so the shape
 * lives here and not in a copy per renderer.
 */
export const STRIP_PILL =
  'inline-flex h-[19px] max-w-full items-center gap-1 truncate rounded-[var(--radius-chip)] px-2 text-label font-semibold leading-[normal]';

/** The person: avatar and name at the pill's height (the prototype's `.av`). */
export const STRIP_PERSON = 'flex h-[19px] min-w-0 items-center gap-1.5 text-label leading-[normal] text-ink-secondary';

/** The faint label before a value that does not name itself ("Priority", "Verdict"): 11px, muted. Text, so --text-muted — not the
 *  faint step, which is for glyphs (it fails 4.5:1 as text). The state and the people carry none. */
export const STRIP_LABEL = 'text-[11px] leading-[normal] text-muted';

export const StripChipContext = createContext(false);
export const useStripChip = () => useContext(StripChipContext);
