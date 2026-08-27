import posthog from 'posthog-js';

/**
 * #424 — the reporting sink for render-time crashes.
 *
 * The ticket is explicit that a boundary which hides a broken widget and
 * reports nothing is WORSE than the crash, because the defect stops being
 * visible. Before this, the only record of a crash was the user's own console,
 * which is why the filter bug (#423) reached us as "the page broke" with no
 * detail — and why it was found by reading a console rather than by a report.
 *
 * PostHog is already initialised in providers.tsx for product analytics, so it
 * is the sink we actually have rather than one we would have to introduce.
 *
 * `console.error` is called UNCONDITIONALLY and first. AC-6: a boundary must
 * not suppress the error in development — Next's dev overlay and the console
 * stay exactly as loud as they were, and the report is additive.
 */
export function reportError(
  error: unknown,
  context: { boundary: string; componentStack?: string | null },
): void {
  // Always, in every environment, before anything that could itself throw.
  console.error(`[${context.boundary}]`, error);

  const err = error instanceof Error ? error : new Error(String(error));
  try {
    posthog.captureException(err, {
      boundary: context.boundary,
      // The component stack is the part that makes a report triageable — a
      // message alone rarely says which widget threw.
      component_stack: context.componentStack ?? undefined,
      pathname: typeof window === 'undefined' ? undefined : window.location.pathname,
    });
  } catch {
    // A reporting failure must never become a second crash inside the boundary
    // that was handling the first one.
  }
}
