import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { canLetAgentThink, canRunAgentNow } from '@/lib/runners/access';
import { toAgentView } from '@/lib/runners/agents';
import type { AgentRecordLike, FieldWithOptions } from '@/lib/runners/agents';
import {
  aiModeOptionId,
  letItThink,
  letItThinkToast,
  NON_AI,
  offersLetItThink,
  offersRunNow,
  openManualWake,
  OWN_AI,
  runNowToast,
  soleOnlineRunner,
} from '@/lib/runners/let-it-think';
import type { RunnerDto } from '@/lib/runners/types';
import { NonAiLine, RunNowButton } from './let-it-think';

/** Ticket #1210 — "Let it think with your AI" and "Run now": who is offered them, what they write, and what a person reads. */

/** The disabled ATTRIBUTE, not the `disabled:` utility classes every Button carries. */
const DISABLED = /<button[^>]*\sdisabled=""/;

// The Agents database's real option set (agents.service.ts ensureField 'ai_mode'): three options, ids opaque.
const FIELDS: FieldWithOptions[] = [
  {
    apiName: 'ai_mode',
    options: [
      { id: 'opt-non', label: 'Non-AI' },
      { id: 'opt-own', label: 'Your own AI' },
      { id: 'opt-story', label: 'StoryOS AI' },
    ],
  },
];
const agentRec = (over: Record<string, unknown> = {}): AgentRecordLike => ({
  id: 'a1',
  title: 'Onboarding Assistant',
  values: { enabled: true, ai_mode: 'opt-non', ...over },
  created_by: 'u-manager',
});
const runner = (id: string, over: Partial<RunnerDto> = {}): RunnerDto => ({
  id,
  name: `Machine ${id}`,
  status: 'active',
  connection: 'online',
  tools: [],
  chosen_tool: 'claude-code',
  runner_version: '1',
  protocol_version: 1,
  paired_at: '2026-11-01T00:00:00Z',
  last_seen_at: null,
  offline_since: null,
  paused_until: null,
  pause_reason: null,
  pending_expires_at: null,
  agents: [],
  ...over,
});

describe('who is offered "Let it think with your AI"', () => {
  const base = { role: 'member', isOwner: true, myAccess: 'editor' as const };
  it('the agent’s manager is offered it', () => expect(canLetAgentThink(base)).toBe(true));
  it('an admin who is not the manager is offered it', () => expect(canLetAgentThink({ role: 'admin', isOwner: false, myAccess: 'admin' })).toBe(true));
  it('a member who is NOT the manager is not', () => expect(canLetAgentThink({ ...base, isOwner: false })).toBe(false));
  it('a guest is not, even when they own the record and hold a grant', () => {
    expect(canLetAgentThink({ role: 'guest', isOwner: true, myAccess: 'creator' })).toBe(false);
  });
  it('the manager without edit access to the Agents database is not (the write would be refused)', () => {
    expect(canLetAgentThink({ ...base, myAccess: 'viewer' })).toBe(false);
    expect(canLetAgentThink({ ...base, myAccess: 'commenter' })).toBe(false);
    expect(canLetAgentThink({ ...base, myAccess: 'contributor' })).toBe(true);
  });
  it('"not loaded yet" is never "allowed"', () => {
    expect(canLetAgentThink({ ...base, myAccess: undefined })).toBe(false);
    expect(canLetAgentThink({ ...base, role: undefined })).toBe(false);
  });
});

describe('which agents are offered it', () => {
  const view = (over: Record<string, unknown>) => toAgentView(agentRec(over), FIELDS);
  it('an enabled Non-AI agent', () => expect(offersLetItThink(view({}))).toBe(true));
  it('an enabled agent with NO mode set counts as Non-AI (unconfigured is not invalid)', () => expect(offersLetItThink(view({ ai_mode: null }))).toBe(true));
  it('an agent already on Your own AI is not', () => expect(offersLetItThink(view({ ai_mode: 'opt-own' }))).toBe(false));
  it('a StoryOS AI agent is not: it already thinks', () => expect(offersLetItThink(view({ ai_mode: 'opt-story' }))).toBe(false));
  it('a switched-off agent is not: the mode would not make it run', () => expect(offersLetItThink(view({ enabled: false }))).toBe(false));
});

describe('the option ids come from the database, never from a hard-coded id', () => {
  it('reads Your own AI and Non-AI from the field options', () => {
    expect(aiModeOptionId(FIELDS, OWN_AI)).toBe('opt-own');
    expect(aiModeOptionId(FIELDS, NON_AI)).toBe('opt-non');
  });
  it('is null when the database has no such option or no field (an older pack): the action then is not offered', () => {
    expect(aiModeOptionId([{ apiName: 'ai_mode', options: [{ id: 'x', label: 'Non-AI' }] }], OWN_AI)).toBeNull();
    expect(aiModeOptionId([], OWN_AI)).toBeNull();
  });
});

describe('the Runner that is preselected', () => {
  it('exactly one online Runner is preselected', () => expect(soleOnlineRunner([runner('r1')])?.id).toBe('r1'));
  it('none online: nothing is guessed', () => expect(soleOnlineRunner([runner('r1', { connection: 'offline' })])).toBeNull());
  it('two online: nothing is guessed', () => expect(soleOnlineRunner([runner('r1'), runner('r2')])).toBeNull());
  it('one online and one offline: the online one', () => expect(soleOnlineRunner([runner('r1', { connection: 'offline' }), runner('r2')])?.id).toBe('r2'));
  it('a paused or outdated Runner is not "online"', () => {
    expect(soleOnlineRunner([runner('r1', { connection: 'paused' })])).toBeNull();
    expect(soleOnlineRunner([runner('r1', { connection: 'outdated' })])).toBeNull();
  });
  it('no Runner at all', () => expect(soleOnlineRunner([])).toBeNull());
});

describe('the switch writes the mode FIRST, then the Runner, and says what happened', () => {
  it('sets Your own AI, then assigns the preselected Runner, in that order', async () => {
    const order: string[] = [];
    const out = await letItThink(
      { setMode: async (id) => void order.push(`mode:${id}`), assign: async (id) => void order.push(`runner:${id}`) },
      'opt-own',
      { id: 'r1', name: 'Machine r1' },
    );
    expect(order).toEqual(['mode:opt-own', 'runner:r1']);
    expect(out.runner).toEqual({ id: 'r1', name: 'Machine r1' });
  });
  it('with nothing to preselect it writes the mode only', async () => {
    const assign = vi.fn();
    const out = await letItThink({ setMode: async () => undefined, assign }, 'opt-own', null);
    expect(assign).not.toHaveBeenCalled();
    expect(out).toEqual({ runner: null, assignError: null });
  });
  it('a refused mode write throws and never touches the Runner', async () => {
    const assign = vi.fn();
    await expect(letItThink({ setMode: async () => Promise.reject(new Error('403')), assign }, 'opt-own', { id: 'r1', name: 'M' })).rejects.toThrow('403');
    expect(assign).not.toHaveBeenCalled();
  });
  it('a refused Runner write keeps the mode and reports it instead of throwing', async () => {
    const setMode = vi.fn(async () => undefined);
    const out = await letItThink({ setMode, assign: async () => Promise.reject(new Error('422')) }, 'opt-own', { id: 'r1', name: 'M' });
    expect(setMode).toHaveBeenCalledTimes(1);
    expect(out.runner).toBeNull();
    expect((out.assignError as Error).message).toBe('422');
    expect(letItThinkToast('Onboarding Assistant', out, true)).toContain('a Runner could not be chosen');
  });
  it('switching back is the same single write with the Non-AI option id (the Advanced entry point calls it)', async () => {
    const setMode = vi.fn(async () => undefined);
    await letItThink({ setMode, assign: async () => undefined }, aiModeOptionId(FIELDS, NON_AI)!, null);
    expect(setMode).toHaveBeenCalledWith('opt-non');
  });
  it('the toast names the machine only when one was chosen, and tells a non-owner admin that the owner must choose', () => {
    expect(letItThinkToast('Onboarding Assistant', { runner: { id: 'r1', name: 'Mac' }, assignError: null }, true)).toBe('Onboarding Assistant now thinks with your AI, on Mac.');
    expect(letItThinkToast('Onboarding Assistant', { runner: null, assignError: null }, true)).toContain('Choose where it runs');
    expect(letItThinkToast('Onboarding Assistant', { runner: null, assignError: null }, false)).toContain('Its owner needs to choose');
  });
});

describe('the Non-AI line as a person reads it', () => {
  it('for the manager: the sentence plus the action', () => {
    const html = renderToStaticMarkup(createElement(NonAiLine, { onAct: () => undefined }));
    expect(html).toContain('It runs its steps without an AI.');
    expect(html).toContain('Let it think with your AI');
    expect(html).not.toContain('needs no Runner');
  });
  it('for anyone else: the old sentence, no action', () => {
    const html = renderToStaticMarkup(createElement(NonAiLine, {}));
    expect(html).toContain('It runs its steps without an AI, so it needs no Runner.');
    expect(html).not.toContain('Let it think');
    expect(html).not.toContain('<button');
  });
  it('while switching the button is disabled, so a double click is not a double write', () => {
    const html = renderToStaticMarkup(createElement(NonAiLine, { onAct: () => undefined, pending: true }));
    expect(html).toMatch(DISABLED);
    expect(html).toContain('Switching');
  });
});

describe('Run now', () => {
  it('only an admin may press it: the start endpoint is admin-only', () => {
    expect(canRunAgentNow('admin')).toBe(true);
    expect(canRunAgentNow('member')).toBe(false);
    expect(canRunAgentNow('guest')).toBe(false);
    expect(canRunAgentNow(undefined)).toBe(false);
  });
  const own = toAgentView(agentRec({ ai_mode: 'opt-own' }), FIELDS);
  const nonAi = toAgentView(agentRec(), FIELDS);
  it('offered for a Your-own-AI agent with a Runner, to someone allowed', () => expect(offersRunNow(own, { id: 'r1' }, true)).toBe(true));
  it('not without a Runner serving it', () => expect(offersRunNow(own, null, true)).toBe(false));
  it('not for a Non-AI agent, even with a leftover assignment', () => expect(offersRunNow(nonAi, { id: 'r1' }, true)).toBe(false));
  it('not for someone who may not run it', () => expect(offersRunNow(own, { id: 'r1' }, false)).toBe(false));

  const wk = (over: Record<string, unknown> = {}) => ({ reason: 'manual', status: 'queued' as const, record: null, ...over });
  it('an open manual wake about no record blocks a second press', () => {
    expect(openManualWake([wk()])).toBe(true);
    expect(openManualWake([wk({ status: 'claimed' })])).toBe(true);
  });
  it('a finished or failed manual wake does not', () => {
    expect(openManualWake([wk({ status: 'done' }), wk({ status: 'failed' }), wk({ status: 'canceled' })])).toBe(false);
  });
  it('a queued wake for a record, or for another reason, does not (it is a different wake)', () => {
    expect(openManualWake([wk({ record: { id: 'x', database_id: null, title: 'Acme', number: 1 } })])).toBe(false);
    expect(openManualWake([wk({ reason: 'state_change' })])).toBe(false);
  });
  it('the button says "Run queued" and is disabled while one is open; "Queuing…" while the click is in flight', () => {
    const queued = renderToStaticMarkup(createElement(RunNowButton, { onRun: () => undefined, pending: false, alreadyQueued: true }));
    expect(queued).toMatch(DISABLED);
    expect(queued).toContain('Run queued');
    const flight = renderToStaticMarkup(createElement(RunNowButton, { onRun: () => undefined, pending: true, alreadyQueued: false }));
    expect(flight).toMatch(DISABLED);
    expect(flight).toContain('Queuing');
    const idle = renderToStaticMarkup(createElement(RunNowButton, { onRun: () => undefined, pending: false, alreadyQueued: false }));
    expect(idle).not.toMatch(DISABLED);
    expect(idle).toContain('Run now');
  });
  it('the toast is honest about whether a Runner can take it now', () => {
    expect(runNowToast('Onboarding Assistant', true, 'Mac')).toContain('starts when the Runner picks it up');
    expect(runNowToast('Onboarding Assistant', false, 'Mac')).toContain('waiting for a Runner');
  });
});

describe('the page wires the gates it is tested against', () => {
  const src = readFileSync(fileURLToPath(new URL('./agent-page.tsx', import.meta.url)), 'utf8');
  it('the action is offered only through canLetAgentThink and offersLetItThink', () => {
    expect(src).toMatch(/mayLetItThink = offersLetItThink\(agent\) && canLetAgentThink\(/);
    expect(src).toContain('onAct={mayLetItThink ? letItThink : undefined}');
  });
  it('Run now is offered only through offersRunNow with canRunAgentNow', () => {
    expect(src).toContain('offersRunNow(agent, assigned, canRunAgentNow(role))');
    expect(src).toContain('{mayRunNow && <RunNowButton');
  });
  it('the catch-up box (ticket #1152) replaced the hook comment, and is drawn only through the named predicates', () => {
    expect(src).not.toContain('HOOK, ticket #1152');
    expect(src).toContain('catchUpCount(catchUpRow)');
    expect(src).toMatch(/offersCatchUp\(\{ usesRunner, hasRunner: Boolean\(assigned\), mayLearnMachine: !masked, count: catchUp \}\)/);
    // Under "Runs on", before the first-time card and the Run now row's neighbours.
    expect(src.indexOf('<RunsOnLine')).toBeLessThan(src.indexOf('<CatchUpBox'));
  });
});
