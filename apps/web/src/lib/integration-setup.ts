export type SetupStepState = 'complete' | 'current' | 'upcoming';

/**
 * A setup journey has one obvious next step. Completed steps stay completed;
 * the first incomplete step is current; everything after it is upcoming.
 */
export function setupStepStates(completed: readonly boolean[]): SetupStepState[] {
  const current = completed.findIndex((value) => !value);
  return completed.map((done, index) => {
    if (done) return 'complete';
    if (index === current) return 'current';
    return 'upcoming';
  });
}
