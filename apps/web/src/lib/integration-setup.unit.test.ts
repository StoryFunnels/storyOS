import { describe, expect, it } from 'vitest';
import { setupStepStates } from './integration-setup';

describe('setupStepStates', () => {
  it('makes the first incomplete step the obvious next step', () => {
    expect(setupStepStates([true, false, false])).toEqual(['complete', 'current', 'upcoming']);
  });

  it('starts at the first step for a new connection', () => {
    expect(setupStepStates([false, false, false])).toEqual(['current', 'upcoming', 'upcoming']);
  });

  it('shows a fully completed journey without a current step', () => {
    expect(setupStepStates([true, true, true])).toEqual(['complete', 'complete', 'complete']);
  });
});
