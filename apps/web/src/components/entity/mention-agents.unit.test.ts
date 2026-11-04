import { describe, expect, it } from 'vitest';
import {
  agentMentionProps,
  agentMentionState,
  agentPickerRows,
  filterMembers,
  mentionInsertContent,
  userMentionProps,
} from './mention-items';

describe('@ picker lists agents under people (ticket #1213)', () => {
  const onb = { id: 'a1', name: 'Onboarding Assistant', enabled: true, aiMode: 'Your own AI' as const };
  const triage = { id: 'a2', name: 'Triage Agent', enabled: true, aiMode: 'Non-AI' as const };
  const off = { id: 'a3', name: 'Old Onboarder', enabled: false, aiMode: 'Your own AI' as const };
  const hosted = { id: 'a4', name: 'Hosted Helper', enabled: true, aiMode: 'StoryOS AI' as const };
  const unset = { id: 'a5', name: 'Fresh Hire', enabled: true, aiMode: null };

  it("'@onb' finds Onboarding Assistant (and a switched-off namesake, disabled) by name", () => {
    const rows = agentPickerRows([triage, off, onb], 'onb');
    expect(rows.map((r) => r.agent.name)).toEqual(['Onboarding Assistant', 'Old Onboarder']);
    expect(rows[0]!.disabledReason).toBeNull();
    expect(rows[1]!.disabledReason).toBe('Switched off');
  });

  it('an empty query lists every agent, mentionable first, stable within each group', () => {
    const rows = agentPickerRows([triage, onb, off, hosted], '');
    expect(rows.map((r) => r.agent.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(rows.map((r) => r.disabledReason !== null)).toEqual([false, true, true, true]);
  });

  it('mirrors the server: only an enabled "Your own AI" agent is mentionable; the others say why', () => {
    expect(agentMentionState(onb)).toEqual({ ok: true });
    expect(agentMentionState(triage)).toEqual({ ok: false, reason: 'Runs without an AI' });
    expect(agentMentionState(off)).toEqual({ ok: false, reason: 'Switched off' });
    expect(agentMentionState(hosted)).toEqual({ ok: false, reason: 'Not on your own AI' });
    // no AI mode yet cannot be woken, and says so rather than vanishing from the list
    expect(agentMentionState(unset)).toEqual({ ok: false, reason: 'Not on your own AI' });
  });

  it('offers only the agents it is given: a guest whose list holds one agent is offered one agent', () => {
    expect(agentPickerRows([onb], '').map((r) => r.agent.id)).toEqual(['a1']);
    expect(agentPickerRows([], 'onb')).toEqual([]);
  });

  it("inserts the shape the server parses: { type:'mention', props:{ kind:'agent', id } } (apps/api/test/agent-wakes.test.ts pins the same literal)", () => {
    const content = mentionInsertContent(agentMentionProps(onb));
    expect(content[0]).toEqual({ type: 'mention', props: { kind: 'agent', id: 'a1', label: 'Onboarding Assistant', db: '' } });
    expect(content[1]).toBe(' ');
  });

  it('leaves people items unchanged', () => {
    expect(userMentionProps({ id: 'u1', name: 'Ada' })).toEqual({ kind: 'user', id: 'u1', label: 'Ada', db: '' });
    expect(filterMembers([{ name: 'Onboarding Owen' }, { name: 'Zed' }], 'onb')).toEqual([{ name: 'Onboarding Owen' }]);
  });
});
