import { describe, expect, it } from 'vitest';
import { glyphShape } from './state-glyph';

/** The state glyph's shape per category — the part that is a decision, not drawing. */
describe('glyphShape — category → shape', () => {
  it('done is a disc with a tick, canceled a disc with a cross', () => {
    expect(glyphShape('completed')).toEqual({ kind: 'tick', pie: 0 });
    expect(glyphShape('canceled')).toEqual({ kind: 'cross', pie: 0 });
  });
  it('backlog is a dashed ring and not started a plain ring, with no pie even when a percent is given', () => {
    expect(glyphShape('backlog', 40)).toEqual({ kind: 'dashed', pie: 0 });
    expect(glyphShape('unstarted', 40)).toEqual({ kind: 'ring', pie: 0 });
  });
  it('in progress is a ring with the percent as its pie, a half when there is none, clamped to a full ring', () => {
    expect(glyphShape('started', 25).pie).toBe(0.25);
    expect(glyphShape('started').pie).toBe(0.5);
    expect(glyphShape('started', 120).pie).toBe(1);
    expect(glyphShape('started', -5).pie).toBe(0);
  });
  it('no category reads as in progress, so an ungrouped percent still draws its pie', () => {
    expect(glyphShape(null, 60)).toEqual({ kind: 'ring', pie: 0.6 });
  });
});
