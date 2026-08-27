'use client';

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { reportError } from '@/lib/report-error';

/**
 * #424 — confine a render error to the thing that threw.
 *
 * A workspace view is where people live, and everything in it is a candidate:
 * cell editors, the filter and sort builders, dashboard tiles, board columns.
 * Several render USER-AUTHORED configuration — a saved view whose field was
 * deleted, a tile pointed at a database the viewer cannot read, a formula whose
 * type changed. Before this, any of those throwing took the whole route: no
 * sidebar, no grid, no way to get back to what you were doing.
 *
 * Two things this deliberately does NOT do:
 *
 *   It does not swallow. `reportError` logs to the console unconditionally and
 *   sends the component stack to PostHog, so a hidden widget still produces a
 *   visible defect (the ticket is explicit that a silent boundary is worse than
 *   a crash).
 *
 *   It does not offer a page reload as the only way out. Recovery is scoped to
 *   what broke — `retry` re-mounts just this subtree, which is the whole point
 *   of a narrow boundary.
 */
interface Props {
  /** Names what failed, in the failure state and in the report. */
  label: string;
  children: ReactNode;
  /** Replaces the default card entirely, for places too small for one. */
  fallback?: (state: { error: Error; retry: () => void }) => ReactNode;
  /** Extra recovery beyond re-mounting — e.g. clearing the filter that threw. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  /** Bumped on retry so the subtree re-mounts rather than re-rendering the
   * same broken state and throwing again immediately. */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, { boundary: this.props.label, componentStack: info.componentStack });
  }

  private retry = (): void => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return <div key={this.state.attempt}>{this.props.children}</div>;
    if (this.props.fallback) return this.props.fallback({ error, retry: this.retry });

    return (
      <div
        role="alert"
        className="m-2 rounded-[var(--radius-control)] border border-border-default bg-card p-3 text-[13px] text-muted"
      >
        <div className="flex items-center gap-2 font-medium text-ink">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          {/* Naming the panel is what makes this reportable by the person who
              hit it — "something went wrong" is not something anyone can file. */}
          {this.props.label} couldn’t be shown
        </div>
        <p className="mt-1">The rest of this page still works. This has been reported.</p>
        <button
          type="button"
          onClick={this.retry}
          className="mt-2 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] text-ink hover:bg-hover"
        >
          <RotateCw className="h-3.5 w-3.5" /> Try again
        </button>
      </div>
    );
  }
}
