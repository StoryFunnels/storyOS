import { describe, expect, it, vi } from 'vitest';
import { announceDecision, causedByLabel, decisionToast, notificationWho, type CausedBy } from './caused-by';

const person = { id: 'u1', name: 'Dana Rule-Author', image: null };
const agent: CausedBy = { agent_id: 'a1', agent_name: 'Sales assistant', run_id: 'r1', run_number: 42, runner_id: 'rn1', runner_name: 'My laptop', label: 'Sales assistant (run 42)' };

describe('notificationWho (ticket #1193)', () => {
  it('an agent-caused approval names the agent and run, not the rule author who is the notification actor', () => {
    expect(notificationWho({ caused_by: agent, actor: person, record: null })).toEqual({ kind: 'agent', name: 'Sales assistant (run 42)' });
  });
  it('a person-caused approval is unchanged: the actor, "Someone" with a record, "StoryOS" without', () => {
    expect(notificationWho({ caused_by: null, actor: person, record: {} })).toMatchObject({ kind: 'person', name: 'Dana Rule-Author' });
    expect(notificationWho({ actor: person, record: null })).toMatchObject({ kind: 'person', name: 'Dana Rule-Author' });
    expect(notificationWho({ caused_by: null, actor: null, record: {} })).toEqual({ kind: 'other', name: 'Someone' });
    expect(notificationWho({ caused_by: null, actor: null, record: null })).toEqual({ kind: 'other', name: 'StoryOS' });
  });
});

describe('causedByLabel — unconfigured is not invalid', () => {
  it('uses the API label when there is one', () => expect(causedByLabel(agent)).toBe('Sales assistant (run 42)'));
  it('a missing label is rebuilt from the agent name and run number', () => {
    expect(causedByLabel({ agent_name: 'Sales assistant', run_number: 42 })).toBe('Sales assistant (run 42)');
    expect(causedByLabel({ agent_name: 'Sales assistant', label: '   ' })).toBe('Sales assistant');
  });
  it('a missing run degrades to the agent name; a missing name to "An agent" — never blank', () => {
    expect(causedByLabel({ agent_name: 'Sales assistant', label: null, run_number: null })).toBe('Sales assistant');
    expect(causedByLabel({ run_number: 7 })).toBe('An agent (run 7)');
    expect(causedByLabel({})).toBe('An agent');
    expect(causedByLabel({ agent_name: '', label: '' })).toBe('An agent');
  });
  it('falls back to the run id when the run has no public number', () => {
    expect(causedByLabel({ agent_name: 'Sales assistant', run_id: 'abc', run_number: null })).toBe('Sales assistant (run abc)');
  });
});

describe('decisionToast / announceDecision — a repeat decision is not a second success', () => {
  it('a first decision is the success toast', () => {
    expect(decisionToast('approve', { id: 'x', status: 'approved', already_decided: false })).toEqual({ kind: 'success', text: 'Approved' });
    expect(decisionToast('reject', { id: 'x', status: 'rejected' })).toEqual({ kind: 'success', text: 'Rejected' });
  });
  it('a repeat approve says "Already approved", a repeat reject "Already rejected"', () => {
    expect(decisionToast('approve', { already_decided: true })).toEqual({ kind: 'info', text: 'Already approved' });
    expect(decisionToast('reject', { already_decided: true })).toEqual({ kind: 'info', text: 'Already rejected' });
  });
  it('on a repeat the SUCCESS toast is never called', () => {
    for (const verdict of ['approve', 'reject'] as const) {
      const toaster = { success: vi.fn(), info: vi.fn() };
      announceDecision(verdict, { already_decided: true }, toaster);
      expect(toaster.success).not.toHaveBeenCalled();
      expect(toaster.info).toHaveBeenCalledWith(verdict === 'approve' ? 'Already approved' : 'Already rejected');
    }
  });
  it('a first decision calls success and not info; a body without the flag (or no body) is a first decision', () => {
    for (const body of [{ already_decided: false }, {}, null, undefined]) {
      const toaster = { success: vi.fn(), info: vi.fn() };
      announceDecision('approve', body, toaster);
      expect(toaster.success).toHaveBeenCalledWith('Approved');
      expect(toaster.info).not.toHaveBeenCalled();
    }
  });
});
