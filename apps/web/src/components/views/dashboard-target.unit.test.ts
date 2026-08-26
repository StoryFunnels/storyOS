import { describe, expect, it } from 'vitest';
import { targetProgress } from './dashboard-tiles';

/**
 * #388 — the traps the ticket names explicitly are the tests worth having.
 * A progress bar is easy; not lying about it is the work.
 */
describe('targetProgress', () => {
  it('reports progress toward a target', () => {
    const p = targetProgress(383, 400)!;
    expect(p.percent).toBeCloseTo(95.75);
    expect(p.ratio).toBeCloseTo(0.9575);
  });

  it('does not clamp the PERCENT past the target — "120% of target" is the point', () => {
    expect(targetProgress(480, 400)!.percent).toBe(120);
  });

  it('does clamp the RATIO, so an exceeded target cannot overflow its bar', () => {
    expect(targetProgress(480, 400)!.ratio).toBe(1);
  });

  describe('direction decides what "good" means', () => {
    it('up: at or over the target is good', () => {
      expect(targetProgress(400, 400, 'up')!.tone).toBe('good');
      expect(targetProgress(500, 400, 'up')!.tone).toBe('good');
    });

    it('down: the target is a CEILING, so under it is good and over it is bad', () => {
      // More overdue invoices is not an achievement. Colouring by size alone
      // would be confidently wrong here, which is worse than no colour.
      expect(targetProgress(5, 10, 'down')!.tone).toBe('good');
      expect(targetProgress(50, 10, 'down')!.tone).toBe('bad');
    });

    it('the same numbers get OPPOSITE tones under opposite directions', () => {
      expect(targetProgress(50, 100, 'up')!.tone).toBe('bad');
      expect(targetProgress(50, 100, 'down')!.tone).toBe('good');
    });

    it('near-miss reads neutral rather than alarming', () => {
      expect(targetProgress(95, 100, 'up')!.tone).toBe('neutral');
    });
  });

  describe('renders NOTHING rather than something wrong', () => {
    it('no target configured', () => {
      expect(targetProgress(383, undefined)).toBeNull();
    });

    it('no value yet — an unloaded tile must not claim 0% of target', () => {
      expect(targetProgress(null, 400)).toBeNull();
    });

    it('a target of zero, which would otherwise divide to Infinity', () => {
      // "∞% of target", stated confidently, on a dashboard.
      expect(targetProgress(383, 0)).toBeNull();
    });

    it('a non-finite target', () => {
      expect(targetProgress(383, Number.NaN)).toBeNull();
      expect(targetProgress(383, Number.POSITIVE_INFINITY)).toBeNull();
    });
  });

  it('a value of zero is a real answer and still renders', () => {
    // Distinct from "no value". Zero of 400 is information; null is not.
    const p = targetProgress(0, 400)!;
    expect(p.percent).toBe(0);
    expect(p.tone).toBe('bad');
  });
});
