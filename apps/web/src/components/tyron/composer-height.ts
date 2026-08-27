/**
 * How tall the composer should be (#402).
 *
 * Extracted from the effect so the RULE is testable without a DOM. The effect
 * itself is three lines of element plumbing; everything that could be wrong
 * about it is here.
 *
 * `max-h-32` and `min-h-8` set a ceiling and a floor on the textarea and nothing
 * drove the height between them, so a long message scrolled inside a one-row
 * box. Measured in a live browser at 1440x900 before the fix: 34px empty, 34px
 * after 180 characters.
 */
export const COMPOSER_MAX_H = 128; // mirrors `max-h-32` (8rem at a 16px root)

export interface ComposerHeight {
  /** Pixel height to set inline. */
  height: number;
  /** Past the cap the content must scroll, or the tail of a long message is unreachable. */
  overflowY: 'auto' | 'hidden';
}

export function composerHeight(scrollHeight: number, max: number = COMPOSER_MAX_H): ComposerHeight {
  return {
    height: Math.min(scrollHeight, max),
    overflowY: scrollHeight > max ? 'auto' : 'hidden',
  };
}
