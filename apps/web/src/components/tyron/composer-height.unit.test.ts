import { describe, expect, it } from 'vitest';
import { COMPOSER_MAX_H, composerHeight } from './composer-height';

/**
 * #402 — the composer grows as you type, up to a point, and then scrolls.
 *
 * The browser numbers these mirror, measured at the ⅓ dock (414px wide) after
 * the fix: 32px empty, 32px for "hello", 71px once the text wraps, 128px capped
 * with `overflow: auto`, and back to 32px when cleared.
 */
describe('#402 composer height', () => {
  it('follows the content while it fits', () => {
    expect(composerHeight(32)).toEqual({ height: 32, overflowY: 'hidden' });
    expect(composerHeight(71)).toEqual({ height: 71, overflowY: 'hidden' });
  });

  it('caps, and then lets the content scroll', () => {
    // Without the overflow flip the tail of a long message would be unreachable:
    // the box stops growing and nothing lets you get to the rest.
    expect(composerHeight(400)).toEqual({ height: COMPOSER_MAX_H, overflowY: 'auto' });
  });

  it('does not flip to scrolling exactly AT the cap', () => {
    // A scrollbar on a box whose content fits it exactly is a visual glitch.
    expect(composerHeight(COMPOSER_MAX_H)).toEqual({ height: COMPOSER_MAX_H, overflowY: 'hidden' });
  });

  it('shrinks back, which is the half a naive fix gets wrong', () => {
    // The effect resets height to `auto` before measuring. Without that,
    // scrollHeight includes the height the box was already given, so the box
    // could only ever grow — deleting text would leave it stretched.
    expect(composerHeight(32).height).toBe(32);
  });
});
