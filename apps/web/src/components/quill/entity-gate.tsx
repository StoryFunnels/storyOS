import type { ReactNode } from 'react';
import { ViewQueryError } from '@/components/views/query-error';
import type { EntityState } from '@/lib/entity-state';
import { QuillNotFound } from './not-found-view';

/**
 * Ticket #1291 — what a page draws instead of its content when its thing cannot be read. The caller keeps drawing its own loading
 * state, so a gone or failed answer is the only thing this returns:
 *
 *   gone   → the 404 page (`QuillNotFound`), the same one an unknown URL gets, with its way back to the workspace Home;
 *   failed → the load-failed state with a Retry. NEVER the 404: we do not know the thing is gone.
 *
 *   const blocked = entityGateView(entityState(query), query.refetch);
 *   if (blocked) return blocked;
 */
export function entityGateView(state: EntityState, onRetry?: () => void): ReactNode | null {
  if (state.kind === 'gone') return <QuillNotFound />;
  if (state.kind === 'failed') return <ViewQueryError error={state.error} onRetry={onRetry} />;
  return null;
}
