'use client';

/**
 * A workspace description waiting to be built (#217).
 *
 * `/new-workspace`'s "describe your work" step creates the workspace first —
 * `POST /workspaces` needs somewhere to point — and only THEN can hand the
 * description to Tyron, since building (#363) runs inside a workspace-scoped
 * thread. That leaves one redirect between "the user typed this" and "the page
 * that can act on it", and sessionStorage is what survives it: per-workspace,
 * same convention as `tyron-thread.ts`'s remembered thread, but sessionStorage
 * rather than localStorage because this is a one-time handoff, not a standing
 * preference — a later visit to the same workspace must never re-trigger it.
 */
const keyFor = (ws: string) => `storyos:pending-build:${ws}`;

export function setPendingBuild(ws: string, description: string): void {
  window.sessionStorage.setItem(keyFor(ws), description);
}

/** Read without consuming — enough to decide whether to force Tyron's panel
 *  open, without racing the component that will actually consume it. */
export function peekPendingBuild(ws: string): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(keyFor(ws));
}

/** Read-and-clear: a pending build applies only to the very next landing on
 *  this workspace. Consuming it here, not in `peekPendingBuild`, so the panel
 *  can check for one without spending it before the build surface exists to
 *  act on it. */
export function takePendingBuild(ws: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = window.sessionStorage.getItem(keyFor(ws));
  if (value !== null) window.sessionStorage.removeItem(keyFor(ws));
  return value;
}
