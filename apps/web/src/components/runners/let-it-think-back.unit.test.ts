import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { canLetAgentThink } from '@/lib/runners/access';
import { toAgentView } from '@/lib/runners/agents';
import type { FieldWithOptions } from '@/lib/runners/agents';
import { aiModeOptionId, NON_AI, offersRunWithoutAi } from '@/lib/runners/let-it-think';
import { confirmLetItThink, RUN_WITHOUT_AI, runWithoutAiToast } from '@/lib/runners/let-it-think-copy';
import { AgentAdvanced } from './agent-advanced';

/** Ticket #1210, Vera's send-back: the way back in Advanced, and the plain words before the switch. */
const FIELDS: FieldWithOptions[] = [
  { apiName: 'ai_mode', options: [{ id: 'opt-non', label: 'Non-AI' }, { id: 'opt-own', label: 'Your own AI' }, { id: 'opt-story', label: 'StoryOS AI' }] },
];
const view = (over: Record<string, unknown>) => toAgentView({ id: 'a1', title: 'Onboarding Assistant', values: { enabled: true, ai_mode: 'opt-own', ...over }, created_by: 'u1' }, FIELDS);
const DISABLED = /<button[^>]*\sdisabled=""/;
const advanced = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(AgentAdvanced, { savedTools: null, savedModel: null, workspaceDefaultModel: null, canEdit: true, ownerName: null, brand: 'Claude', chosenTool: 'claude-code', saving: false, onSave: async () => undefined, ...extra }),
  );

describe('Run without an AI: who is offered it, and what it writes', () => {
  it('only an enabled agent that thinks with your own AI', () => {
    expect(offersRunWithoutAi(view({}))).toBe(true);
    expect(offersRunWithoutAi(view({ ai_mode: 'opt-non' }))).toBe(false);
    expect(offersRunWithoutAi(view({ ai_mode: 'opt-story' }))).toBe(false);
    expect(offersRunWithoutAi(view({ enabled: false }))).toBe(false);
  });
  it('the gate is the same one as the reverse switch: manager or admin with edit access, never a guest or an unrelated member', () => {
    const ok = { role: 'member', isOwner: true, myAccess: 'editor' as const };
    expect(canLetAgentThink(ok)).toBe(true);
    expect(canLetAgentThink({ role: 'admin', isOwner: false, myAccess: 'admin' })).toBe(true);
    expect(canLetAgentThink({ ...ok, isOwner: false })).toBe(false);
    expect(canLetAgentThink({ ...ok, myAccess: 'viewer' })).toBe(false);
    expect(canLetAgentThink({ role: 'guest', isOwner: true, myAccess: 'creator' })).toBe(false);
  });
  it('writes Non-AI: the option id comes from the Agents database field', () => {
    expect(aiModeOptionId(FIELDS, NON_AI)).toBe('opt-non');
    expect(aiModeOptionId([{ apiName: 'ai_mode', options: [{ id: 'x', label: 'Your own AI' }] }], NON_AI)).toBeNull();
  });
});

describe('Advanced draws the control only when it is passed', () => {
  it('present for the manager or admin of a Your-own-AI agent', () => {
    const html = advanced({ runWithoutAi: { onSwitch: () => undefined, pending: false } });
    expect(html).toContain('data-testid="agent-ai-mode"');
    expect(html).toContain(RUN_WITHOUT_AI.button);
    expect(html).not.toMatch(DISABLED);
  });
  it('absent for anyone else: nothing of the section is in the markup', () => {
    const html = advanced();
    expect(html).not.toContain('agent-ai-mode');
    expect(html).not.toContain(RUN_WITHOUT_AI.button);
  });
  it('disabled while the write is in flight', () => {
    expect(advanced({ runWithoutAi: { onSwitch: () => undefined, pending: true } })).toMatch(DISABLED);
  });
});

describe('the plain words before "Let it think with your AI"', () => {
  const c = confirmLetItThink('Onboarding Assistant');
  it('names the agent and the effect in the title', () => expect(c.title).toBe('Let Onboarding Assistant think with your AI?'));
  it('says cost: never metered on StoryOS, own subscription, own machine', () => {
    expect(c.message).toContain('never metered on StoryOS');
    expect(c.message).toContain('your own subscription, on your own computer');
  });
  it('says privacy: the record content goes to their own AI', () => expect(c.message).toContain('the record content it works on goes to your own AI'));
  it('says it does not start a run by itself', () => expect(c.message).toContain('does not start a run by itself'));
  it('is not styled as destructive', () => expect(c.danger).toBe(false));
  it('the switch-back words and toast', () => {
    expect(RUN_WITHOUT_AI.note).toContain('stops using your Runner');
    expect(runWithoutAiToast('Onboarding Assistant')).toBe('Onboarding Assistant now runs its steps without an AI.');
  });
});

describe('the page wires the gates and the confirm', () => {
  const src = readFileSync(fileURLToPath(new URL('./agent-page.tsx', import.meta.url)), 'utf8');
  it('the switch asks first, and Cancel returns before any write', () => {
    expect(src).toMatch(/if \(!\(await confirm\(confirmLetItThink\(agent!\.name\)\)\)\) return;\s+const preselect/);
  });
  it('Advanced gets the way back only through offersRunWithoutAi and canLetAgentThink', () => {
    expect(src).toMatch(/mayRunWithoutAi = offersRunWithoutAi\(agent\) && canLetAgentThink\(/);
    expect(src).toContain('runWithoutAi={mayRunWithoutAi ?');
  });
  it('the catch-up hook comment for ticket #1152 is gone: the box took its place', () => {
    expect(src).not.toContain('HOOK, ticket #1152');
    expect(src).toContain('<CatchUpBox');
  });
});
