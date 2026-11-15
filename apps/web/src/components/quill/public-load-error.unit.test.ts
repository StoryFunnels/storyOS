import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ticket #1291 (Vera, PR 1520): "Try again" used to call only `reset()`, which re-renders the segment with the error the server
 * already stored, so with the API back up the button still did nothing. The retry must refresh the route's server data AND reset,
 * in one transition. The button is rendered through a stand-in that captures its onClick, so the test CLICKS it (the old test
 * passed `reset: () => {}` and could not tell).
 */
const refresh = vi.fn();
const clicks: Array<() => void> = [];
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: () => {}, replace: () => {} }) }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ onClick, children }: { onClick?: () => void; children?: ReactNode }) => {
    if (onClick) clicks.push(onClick);
    return createElement('button', null, children);
  },
}));
vi.mock('@/lib/report-error', () => ({ reportError: () => {} }));

beforeEach(() => {
  refresh.mockClear();
  clicks.length = 0;
});

describe('PublicLoadError retry', () => {
  it('clicking "Try again" refreshes the route AND resets the boundary', async () => {
    const { PublicLoadError } = await import('./public-load-error');
    const reset = vi.fn();
    renderToStaticMarkup(createElement(PublicLoadError, { error: new Error('x'), reset }));
    expect(clicks).toHaveLength(1);
    clicks[0]!();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('retryLoad runs both inside the transition, refresh first (so reset clears the boundary once new data is requested)', async () => {
    const { retryLoad } = await import('./public-load-error');
    const order: string[] = [];
    let inside = false;
    const transition = (fn: () => void) => {
      inside = true;
      fn();
      inside = false;
    };
    retryLoad(
      () => order.push(inside ? 'refresh(in transition)' : 'refresh(outside)'),
      () => order.push(inside ? 'reset(in transition)' : 'reset(outside)'),
      transition,
    );
    expect(order).toEqual(['refresh(in transition)', 'reset(in transition)']);
  });
});
