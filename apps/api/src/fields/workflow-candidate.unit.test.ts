import { describe, expect, it } from 'vitest';
import { lifecycleLabelsIn, nameLooksLikeLifecycle, scoreWorkflowCandidate } from './workflow-candidate';

const f = (displayName: string, optionLabels: string[], apiName = displayName.toLowerCase().replace(/\W+/g, '_')) => ({ displayName, apiName, optionLabels });

describe('#598 workflow candidate heuristic', () => {
  it('a real lifecycle column: name AND labels agree -> high', () => {
    const s = scoreWorkflowCandidate(f('Status', ['Backlog', 'To do', 'In progress', 'Done']));
    expect(s?.confidence).toBe('high');
    expect(s?.reasons.join(' ')).toMatch(/named "Status"/);
  });

  it('a lifecycle with an unhelpful name is still found by its labels (medium, and says why)', () => {
    const s = scoreWorkflowCandidate(f('Column', ['Backlog', 'Doing', 'In review', 'Shipped']));
    expect(s?.confidence).toBe('medium');
    expect(s?.reasons.join(' ')).toMatch(/lifecycle labels/);
  });

  it('a RAG column called "Status" matches by NAME ONLY and is flagged low, with the reason (the common false friend)', () => {
    const s = scoreWorkflowCandidate(f('Status', ['Red', 'Amber', 'Green']));
    expect(s?.confidence).toBe('low');
    expect(s?.reasons.join(' ')).toMatch(/only the NAME matches/);
  });

  it('what must NOT be suggested: Priority, Type, Owner team, a rating, a plain category', () => {
    for (const [name, opts] of [
      ['Priority', ['Low', 'Medium', 'High', 'Urgent']],
      ['Type', ['Bug', 'Feature', 'Chore']],
      ['Owner team', ['Design', 'Engineering', 'Sales']],
      ['Rating', ['1', '2', '3', '4', '5']],
      ['Region', ['EMEA', 'APAC', 'Americas']],
    ] as const) {
      expect(scoreWorkflowCandidate(f(name, [...opts])), name).toBeNull();
    }
  });

  it('labels match WHOLE, normalised: "In-Progress" and "in_progress" count, "Done deal" and "Closed won"-style sentences do not', () => {
    expect(lifecycleLabelsIn(['In-Progress', 'in_progress', 'DONE', 'Done deal', 'Closed won', 'Opened by customer'])).toEqual(['In-Progress', 'in_progress', 'DONE']);
  });

  it('one lifecycle-looking label is not enough (a "Review" column that is a task type)', () => {
    expect(scoreWorkflowCandidate(f('Kind', ['Review', 'Design', 'Build']))).toBeNull();
  });

  it('name tokens are whole words in the display OR api name: "Deal stage" yes, "Statuses report" and "Estate" no', () => {
    expect(nameLooksLikeLifecycle('Deal stage', 'deal_stage')).toBe('stage');
    expect(nameLooksLikeLifecycle('Whatever', 'ticket_status')).toBe('status');
    expect(nameLooksLikeLifecycle('Statuses report', 'statuses_report')).toBeNull();
    expect(nameLooksLikeLifecycle('Estate', 'estate')).toBeNull();
  });

  it('high outranks medium outranks low inside one database (the ordering the scan uses)', () => {
    const high = scoreWorkflowCandidate(f('Status', ['To do', 'Doing', 'Done']))!;
    const medium = scoreWorkflowCandidate(f('Column', ['To do', 'Doing', 'Done']))!;
    const low = scoreWorkflowCandidate(f('Status', ['Red', 'Green']))!;
    expect(high.score).toBeGreaterThan(medium.score);
    expect(medium.score).toBeGreaterThan(low.score);
  });
});
