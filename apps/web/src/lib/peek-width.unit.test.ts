import { describe, expect, it } from 'vitest';
import {
  PEEK_VIEW_MIN,
  PEEK_WIDTH_DEFAULT,
  PEEK_WIDTH_MAX,
  PEEK_WIDTH_MIN,
  clampPeekWidth,
  peekWidthFromPointer,
} from './peek-width';

describe('clampPeekWidth (#996): the peek is sized to the record, and the view keeps the rest', () => {
  it('leaves a sensible width alone on a wide screen', () => {
    expect(clampPeekWidth(680, 1700)).toBe(680);
  });

  it('never exceeds the absolute maximum, however wide the screen', () => {
    expect(clampPeekWidth(5000, 4000)).toBe(PEEK_WIDTH_MAX);
  });

  it('never goes below the minimum a record can be read at', () => {
    expect(clampPeekWidth(100, 2000)).toBe(PEEK_WIDTH_MIN);
  });

  it('leaves the view its own minimum: the peek gives way before the view disappears', () => {
    expect(clampPeekWidth(900, 1000)).toBe(1000 - PEEK_VIEW_MIN);
    expect(clampPeekWidth(680, 800)).toBe(800 - PEEK_VIEW_MIN);
  });

  it('on a container too narrow for both, the peek stops at ITS minimum, not below it', () => {
    expect(clampPeekWidth(680, 600)).toBe(PEEK_WIDTH_MIN);
  });

  it('an unmeasured container (0) applies only the absolute limits', () => {
    expect(clampPeekWidth(680, 0)).toBe(680);
    expect(clampPeekWidth(2000, 0)).toBe(PEEK_WIDTH_MAX);
  });

  it('a non-finite stored value falls back to the default instead of poisoning the layout', () => {
    expect(clampPeekWidth(Number.NaN, 2000)).toBe(PEEK_WIDTH_DEFAULT);
  });
});

describe('peekWidthFromPointer', () => {
  it('is the distance from the pointer to the right edge, clamped', () => {
    expect(peekWidthFromPointer(1300, 2000, 1700)).toBe(700);
    expect(peekWidthFromPointer(1900, 2000, 1700)).toBe(PEEK_WIDTH_MIN);
    expect(peekWidthFromPointer(100, 2000, 1700)).toBe(PEEK_WIDTH_MAX);
  });
});
