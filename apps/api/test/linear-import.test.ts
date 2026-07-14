import { describe, expect, it } from 'vitest';
import { pickOption } from '../src/integrations/linear.service';

// The State select field the importer seeds on the Issues database.
const STATE = new Map([
  ['Triage', 't'],
  ['Backlog', 'b'],
  ['To Do', 'todo'],
  ['In Progress', 'ip'],
  ['In Review', 'ir'],
  ['Done', 'done'],
  ['Canceled', 'cx'],
]);

describe('linear import state mapping (#68)', () => {
  it('maps a Linear "In Review" state (type started) to In Review, not In Progress', () => {
    // Candidates: state.name, STATE_MAP[state.type], 'Backlog'
    expect(pickOption(STATE, 'In Review', 'In Progress', 'Backlog')).toBe('ir');
  });

  it('is case-insensitive on the label', () => {
    expect(pickOption(STATE, 'done')).toBe('done');
    expect(pickOption(STATE, 'IN PROGRESS')).toBe('ip');
  });

  it('falls back to the type category when the state name is not an option', () => {
    // A custom Linear state "Shipping" of type completed → Done via the category.
    expect(pickOption(STATE, 'Shipping', 'Done', 'Backlog')).toBe('done');
  });

  it('falls back to Backlog only when nothing else matches', () => {
    expect(pickOption(STATE, 'Whatever', 'AlsoUnknown', 'Backlog')).toBe('b');
  });

  it('returns null when no candidate matches and there is no fallback', () => {
    expect(pickOption(STATE, 'Nope')).toBeNull();
    expect(pickOption(STATE, undefined)).toBeNull();
  });
});
