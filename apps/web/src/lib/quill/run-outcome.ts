import type { WakeDto } from '@/lib/runners/types';
import type { QuillPose } from '@/components/quill/quill-poses';

/**
 * #1253 — which run rows get Quill beside their state pill (Dara's approved table, v71/v72). She sits BESIDE the pill, never instead
 * of it: every row keeps its pill and its plain row text.
 *
 *   done, and the agent's FIRST successful run  -> 05 "Order up."
 *   done, any other                              -> none (a quiet row)
 *   failed                                       -> 09 "Dropped it."
 *   needs your approval                          -> 07 "Your call."
 *   waiting for your Claude/Cursor limit         -> 06 "Asleep in the pot."
 *   canceled, running, queued, every other wait  -> none
 *
 * "Notable" is the FIRST success only in v1 (Otto). No notability rule is invented here; it is revisited when there is data.
 */
export type RunQuill = { pose: QuillPose; caption: string };

export function runQuill(w: Pick<WakeDto, 'id' | 'run_state'>, firstSuccessId: string | null): RunQuill | null {
  switch (w.run_state.state) {
    case 'done':
      return w.id === firstSuccessId ? { pose: 'order', caption: 'Order up.' } : null;
    case 'failed':
      return { pose: 'drop', caption: 'Dropped it.' };
    case 'needs_approval':
      return { pose: 'call', caption: 'Your call.' };
    case 'waiting_for_limit':
      return { pose: 'asleep', caption: 'Asleep in the pot.' };
    default:
      return null;
  }
}

/**
 * The id of the agent's first successful run, or null when that cannot be known.
 *
 * It CAN be known only when the list holds the agent's whole history (`more` is false): with a longer history the earliest success on
 * screen is only the earliest of the latest page, and calling it "the first" would celebrate a run that is not. Unknown reads as "no
 * celebration", never as a guess.
 */
export function firstSuccessfulRunId(wakes: readonly Pick<WakeDto, 'id' | 'run_state' | 'finished_at' | 'created_at'>[], more: boolean): string | null {
  if (more) return null;
  const done = wakes.filter((w) => w.run_state.state === 'done');
  if (done.length === 0) return null;
  const at = (w: (typeof done)[number]) => Date.parse(w.finished_at ?? w.created_at);
  return done.reduce((a, b) => (at(b) < at(a) ? b : a)).id;
}
