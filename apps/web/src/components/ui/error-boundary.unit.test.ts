import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ErrorInfo } from 'react';

/**
 * #424 — a render error must cost the widget, not the page.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, stated up front because the difference
 * matters: React error boundaries are a CLIENT reconciler feature.
 * `renderToStaticMarkup` does not run them — an error thrown during server
 * render propagates straight out, which this repo's test setup (no jsdom, no
 * RTL — see vitest.config.ts) cannot intercept.
 *
 * So the tests below exercise the three pieces React calls, directly:
 * `getDerivedStateFromError`, `componentDidCatch`, and the fallback `render`.
 * That covers all of OUR logic. What it does not cover is React actually
 * invoking them, which is React's own documented contract rather than something
 * this codebase implements.
 *
 * Closing that last gap needs a DOM test environment. That is a repo-wide
 * dependency decision (jsdom + a client render helper), so it is filed rather
 * than smuggled in here — see the PR.
 */
const reported: Array<{ error: unknown; context: { boundary: string; componentStack?: string | null } }> = [];
vi.mock('@/lib/report-error', () => ({
  reportError: (error: unknown, context: { boundary: string; componentStack?: string | null }) => {
    reported.push({ error, context });
  },
}));

const { ErrorBoundary } = await import('./error-boundary');

beforeEach(() => {
  reported.length = 0;
});

/** Build an instance in the state React puts it in after a child throws. */
function crashed(props: { label: string; onReset?: () => void; fallback?: never }) {
  const boundary = new ErrorBoundary({ ...props, children: null } as never);
  const error = new Error('widget exploded');
  Object.assign(boundary.state, ErrorBoundary.getDerivedStateFromError(error));
  // setState is React-owned; stub it so `retry` can be exercised standalone.
  boundary.setState = ((updater: unknown) => {
    const next = typeof updater === 'function' ? (updater as (s: unknown) => object)(boundary.state) : updater;
    Object.assign(boundary.state, next);
  }) as never;
  return { boundary, error };
}

describe('#424 — ErrorBoundary', () => {
  it('captures the error into state, which is what swaps in the fallback', () => {
    const error = new Error('widget exploded');
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });

  it('reports the error rather than swallowing it', () => {
    // The ticket is explicit: a boundary that hides a broken widget and reports
    // nothing is WORSE than the crash, because the defect stops being visible.
    const { boundary, error } = crashed({ label: 'This tile' });
    boundary.componentDidCatch(error, { componentStack: '\n at DateFilterInput' } as ErrorInfo);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.context.boundary).toBe('This tile');
    // The component stack is the part that makes a report triageable at all.
    expect(reported[0]!.context.componentStack).toContain('DateFilterInput');
  });

  it('NAMES what failed, so the person who hit it can report it', () => {
    const { boundary } = crashed({ label: 'The view toolbar' });
    const html = renderToStaticMarkup(boundary.render() as never);
    // "Something went wrong" is not something anyone can file a ticket about.
    expect(html).toContain('The view toolbar');
    expect(html).toMatch(/rest of this page still works/i);
  });

  it('offers recovery scoped to what broke, not a full page reload', () => {
    const { boundary } = crashed({ label: 'This tile' });
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toContain('Try again');
    expect(html.toLowerCase()).not.toContain('reload the page');
  });

  it('does not leak the raw error text into the UI', () => {
    // Users get a name they can quote; the message and stack go to the sink.
    const { boundary } = crashed({ label: 'This tile' });
    expect(renderToStaticMarkup(boundary.render() as never)).not.toContain('widget exploded');
  });

  it('retry clears the error AND runs the caller’s reset', () => {
    // Re-mounting alone would replay the same broken input and throw again, so
    // a boundary around user config needs the caller to be able to clear it.
    const onReset = vi.fn();
    const { boundary } = crashed({ label: 'The view toolbar', onReset });
    const before = boundary.state.attempt;
    (boundary.render() as { props: { children: unknown } }); // fallback rendered
    // `retry` is private by convention; invoke it the way the button does.
    (boundary as unknown as { retry: () => void }).retry();
    expect(onReset).toHaveBeenCalledOnce();
    expect(boundary.state.error).toBeNull();
    // Bumped so the subtree re-MOUNTS rather than re-rendering broken state.
    expect(boundary.state.attempt).toBe(before + 1);
  });

  it('renders children untouched when nothing has thrown', () => {
    const boundary = new ErrorBoundary({ label: 'A panel', children: 'still here' } as never);
    expect(renderToStaticMarkup(boundary.render() as never)).toContain('still here');
  });
});
