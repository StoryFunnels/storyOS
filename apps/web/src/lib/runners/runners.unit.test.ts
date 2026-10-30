import { describe, expect, it } from 'vitest';
import { cannotRunCount, summaryFor, toAgentView, waitingLine } from './agents';
import { canUseRunners } from './access';
import { buildHireValues, canSubmitHire } from './hire';
import { canPressDone, codeAriaLabel, defaultTool, displayCode, pairingReducer, pairingStart, pickableTools, shouldPoll } from './pairing';
import type { PairingState } from './pairing';
import { buildRunsOnMenu, canChangeRunsOn, hireState, ownerRunners, runsOnLine } from './runs-on';
import { describeRun, describeRunner, GOLD_TONES, reasonLine } from './status';
import type { StatusTone } from './status';
import type { RunnerDto, RunStateName, WakeDto, WakeSummary } from './types';
import { agentsLine, checkedAgo, clockTime, COPY, confirmRemoveRunner, limitBrand, readyToast, removeConfirmMessage, shortDate, toolName } from './words';

/** Ticket #1139. Every rule below has a mutation in its name: the test says what breaks when the rule does. */
const TZ = { timeZone: 'UTC' };
const NOW = new Date('2026-10-29T14:00:00Z');

const tools = [
  { id: 'claude-code', name: 'Claude Code', installed: true },
  { id: 'cursor', name: 'Cursor', installed: true },
];
const runner = (over: Partial<RunnerDto> = {}): RunnerDto => ({
  id: 'r1',
  name: 'Ievgen’s MacBook Pro',
  status: 'active',
  connection: 'online',
  tools,
  chosen_tool: 'claude-code',
  runner_version: '0.0.1',
  protocol_version: 1,
  paired_at: '2026-10-29T09:00:00Z',
  last_seen_at: '2026-10-29T13:59:00Z',
  offline_since: null,
  paused_until: null,
  pause_reason: null,
  pending_expires_at: null,
  agents: [{ id: 'a1', name: 'Onboarding Assistant' }],
  ...over,
});
const wake = (state: RunStateName, extra: Partial<WakeDto['run_state']> = {}, over: Partial<WakeDto> = {}): WakeDto => ({
  id: 'w1',
  agent: { id: 'a1', name: 'Onboarding Assistant' },
  record: { id: 'rec', database_id: 'db', title: 'Acme Co (sample)', number: 1 },
  reason: 'state_change',
  coalesced_count: 1,
  status: 'queued',
  run_id: null,
  run_state: { state, ...extra },
  created_at: '2026-10-12T09:00:00Z',
  finished_at: null,
  ...over,
});

describe('the Runner status line (Settings › Runners)', () => {
  it('online says when it was last checked', () => {
    expect(describeRunner(runner(), NOW, TZ)).toEqual({ tone: 'on', label: 'Online · checked a minute ago' });
  });
  it('offline says since when and that agents wait, in grey, never an alarm', () => {
    const l = describeRunner(runner({ connection: 'offline', offline_since: '2026-10-29T18:40:00Z' }), NOW, TZ);
    expect(l).toEqual({ tone: 'off', label: 'Offline since 18:40 · agents wait until it’s back' });
  });
  it('a limit wait is amber and names the SUBSCRIPTION of the chosen tool (the v42 bug: "Claude" while Cursor was chosen)', () => {
    const claude = describeRunner(runner({ connection: 'paused', pause_reason: 'limit_reached', paused_until: '2026-10-29T14:00:00Z' }), NOW, TZ);
    expect(claude).toEqual({ tone: 'limit', label: 'Waiting for your Claude limit to reset at 14:00' });
    const cursor = describeRunner(runner({ chosen_tool: 'cursor', connection: 'paused', pause_reason: 'limit_reached', paused_until: '2026-10-29T14:00:00Z' }), NOW, TZ);
    expect(cursor.label).toBe('Waiting for your Cursor limit to reset at 14:00');
  });
  it('a tool that vanished from the computer says which one, and an old Runner says the one command that fixes it', () => {
    expect(describeRunner(runner({ connection: 'tool_missing' }), NOW, TZ).label).toBe('Claude Code was not found on this computer · agents wait');
    expect(describeRunner(runner({ connection: 'outdated' }), NOW, TZ).label).toContain('npx @storyos/runner@latest');
  });
  it('a pause for any reason other than a limit is not called a limit (quiet hours are #1137, not built)', () => {
    expect(describeRunner(runner({ connection: 'paused', pause_reason: 'quiet_hours', paused_until: '2026-10-29T18:00:00Z' }), NOW, TZ).label).toBe('Paused until 18:00');
  });
});

describe('run states exactly as drawn (AC5): every one of the nine', () => {
  const cases: Array<[RunStateName, StatusTone, RegExp]> = [
    ['needs_approval', 'ask', /^Needs your approval$/],
    ['running', 'go', /^Running$/],
    ['done', 'done', /^Done$/],
    ['failed', 'fail', /^Failed$/],
    ['canceled', 'cancel', /^Canceled$/],
    ['waiting_for_runner', 'off', /^Waiting for a Runner$/],
    ['runner_offline', 'off', /^Runner offline · starts when it’s back$/],
    ['waiting_for_limit', 'limit', /^Waiting for your .* limit to reset$/],
    ['waiting_for_turn', 'off', /^Waiting for the Runner$/],
  ];
  it.each(cases)('%s is the %s tone', (state, tone, label) => {
    const l = describeRun(wake(state), TZ);
    expect(l.tone).toBe(tone);
    expect(l.label).toMatch(label);
  });
  it('a queued run with a Runner assigned says where it will start, not "Waiting for a Runner"', () => {
    expect(describeRun(wake('waiting_for_runner', { runner_name: 'Studio Mac' }), TZ).label).toBe('Waiting to start on Studio Mac');
    expect(describeRun(wake('waiting_for_runner'), TZ).label).toBe('Waiting for a Runner');
  });
  it('carries the instants: the running machine, the offline-since clock, the limit reset time and tool, the finish date', () => {
    expect(describeRun(wake('running', { runner_name: 'Ievgen’s MacBook Pro' }), TZ).label).toBe('Running on Ievgen’s MacBook Pro');
    expect(describeRun(wake('runner_offline', { since: '2026-10-29T18:40:00Z' }), TZ).label).toBe('Runner offline since 18:40 · starts when it’s back');
    expect(describeRun(wake('waiting_for_limit', { until: '2026-10-30T14:00:00Z', tool: 'cursor' }), TZ).label).toBe('Waiting for your Cursor limit to reset at 14:00');
    expect(describeRun(wake('done', {}, { finished_at: '2026-10-12T10:00:00Z' }), TZ).label).toBe('Done · 12 Oct');
    expect(describeRun(wake('failed', {}, { finished_at: '2026-10-14T10:00:00Z' }), TZ).label).toBe('Failed · 14 Oct');
    expect(describeRun(wake('canceled', {}, { finished_at: '2026-10-20T10:00:00Z' }), TZ).label).toBe('Canceled · 20 Oct');
  });
  it('GOLD is only an agent acting or asking: exactly the running and approval tones, no other state is gold', () => {
    expect([...GOLD_TONES].sort()).toEqual(['ask', 'go']);
    const goldStates = cases.map(([s]) => s).filter((s) => GOLD_TONES.includes(describeRun(wake(s), TZ).tone));
    expect(goldStates.sort()).toEqual(['needs_approval', 'running']);
  });
  it('failed is not gold and not grey, canceled is neutral, waiting and offline are calm grey, the limit is amber', () => {
    expect(describeRun(wake('failed'), TZ).tone).toBe('fail');
    expect(describeRun(wake('canceled'), TZ).tone).toBe('cancel');
    expect(describeRun(wake('runner_offline'), TZ).tone).toBe('off');
    expect(describeRun(wake('waiting_for_runner'), TZ).tone).toBe('off');
    expect(describeRun(wake('waiting_for_limit'), TZ).tone).toBe('limit');
  });
  it('NEVER claims a failed or canceled run changed nothing (the API does not say; Dara: "never claim no changes without checking")', () => {
    for (const s of ['failed', 'canceled'] as const) {
      const l = describeRun(wake(s), TZ);
      expect(l.sub ?? '').not.toMatch(/nothing was changed|before it changed anything|stopped it/i);
    }
  });
  it('offers Review only on an approval, and never a "Try again" (no endpoint re-queues a wake)', () => {
    expect(describeRun(wake('needs_approval'), TZ).action).toBe('review');
    for (const [s] of cases.filter(([s]) => s !== 'needs_approval')) expect(describeRun(wake(s), TZ).action).toBeNull();
  });
  it('the one-job-at-a-time row says so in its sub-line', () => {
    expect(describeRun(wake('waiting_for_turn'), TZ).sub).toBe('Waiting its turn: the Runner does one job at a time');
  });
  it('why it woke is words, and a reason this build has never heard of is not shown as a raw slug', () => {
    expect(reasonLine({ reason: 'assigned', coalesced_count: 1 })).toBe('Set on it as its agent');
    expect(reasonLine({ reason: 'something_new', coalesced_count: 1 })).toBe('Woken');
    expect(reasonLine({ reason: 'state_change', coalesced_count: 3 })).toContain('3 changes');
  });
});

describe('the Runs on menu is the agent OWNER’s Runners and nothing else (ADR-0021 Q2)', () => {
  const mine = [runner({ id: 'r1' }), runner({ id: 'r2', name: 'Studio Mac' }), runner({ id: 'r3', status: 'pending' }), runner({ id: 'r4', status: 'revoked', connection: 'revoked' })];
  it('the owner is offered their own ACTIVE Runners (a pending or removed one is not)', () => {
    expect(ownerRunners(mine, 'me', 'me').map((r) => r.id)).toEqual(['r1', 'r2']);
  });
  it('anyone else, an admin included, is offered NONE: the list is the caller’s own and it must not be offered for another person’s agent', () => {
    expect(ownerRunners(mine, 'colleague', 'me')).toEqual([]);
    expect(canChangeRunsOn('colleague', 'me')).toBe(false);
  });
  it('an agent with no known owner, or a viewer with no known id, offers nothing (unknown is not allowed)', () => {
    expect(ownerRunners(mine, null, 'me')).toEqual([]);
    expect(ownerRunners(mine, 'me', undefined)).toEqual([]);
    expect(canChangeRunsOn(null, null)).toBe(false);
  });
  it('the menu is the Runners, then "Add a Runner…", and with none it is only that', () => {
    const items = buildRunsOnMenu(ownerRunners(mine, 'me', 'me'), 'r2');
    expect(items.map((i) => i.kind)).toEqual(['runner', 'runner', 'add']);
    expect(items.filter((i) => i.kind === 'runner' && i.selected)).toHaveLength(1);
    expect(buildRunsOnMenu([], null).map((i) => i.kind)).toEqual(['add']);
  });
  it('has NO API-key item: not in v1 (Dara, ticket #1139)', () => {
    const text = JSON.stringify(buildRunsOnMenu(ownerRunners(mine, 'me', 'me'), null));
    expect(text).not.toMatch(/api key|apikey|api_key/i);
  });
  it('the line reads "Runs on <machine> · <tool>", the tool being the Runner’s own choice', () => {
    expect(runsOnLine({ id: 'r1', name: 'Ievgen’s MacBook Pro' }, mine)).toEqual({ kind: 'runner', machine: 'Ievgen’s MacBook Pro', tool: 'Claude Code', masked: false });
    expect(runsOnLine({ id: 'r1', name: 'M' }, [runner({ chosen_tool: 'cursor' })]).tool).toBe('Cursor');
    expect(runsOnLine(null, mine)).toEqual({ kind: 'none', machine: null, tool: null, masked: false });
    expect(runsOnLine({ id: 'r1', name: 'Olga’s laptop' }, mine, true)).toEqual({ kind: 'runner', machine: null, tool: null, masked: true });
  });
});

describe('hiring is NEVER blocked by the lack of a Runner (Otto AC2)', () => {
  it('canHire is true with no Runner, with one, and the no-Runner note is Dara’s sentence', () => {
    expect(hireState(null).canHire).toBe(true);
    expect(hireState(undefined)).toEqual({ canHire: true, note: 'You can hire it now. It starts work once it has a Runner.' });
    expect(hireState({ id: 'r1' })).toEqual({ canHire: true, note: null });
  });
  it('the Hire button needs a name and nothing about a Runner', () => {
    expect(canSubmitHire('Sales assistant', false)).toBe(true);
    expect(canSubmitHire('   ', false)).toBe(false);
    expect(canSubmitHire('Sales assistant', true)).toBe(false);
  });
  it('the record it writes is "Your own AI", enabled, with the option ID and rich-text BLOCKS the API demands', () => {
    const fields = [
      { apiName: 'name', type: 'title' },
      { apiName: 'ai_mode', type: 'select', options: [{ id: 'o1', label: 'Non-AI' }, { id: 'o2', label: 'Your own AI' }] },
    ];
    expect(buildHireValues({ name: ' Sales assistant ', goal: 'Follow up' }, fields)).toEqual({
      name: 'Sales assistant',
      goal: [{ type: 'paragraph', content: [{ type: 'text', text: 'Follow up' }] }],
      ai_mode: 'o2',
      enabled: true,
    });
    expect(buildHireValues({ name: 'x', goal: '' }, fields)).not.toHaveProperty('goal');
    expect(buildHireValues({ name: 'x', goal: '' }, [])).toBeNull(); // fields not loaded yet: do not write a half record
  });
});

describe('the pairing state machine (AC2)', () => {
  const issued = { id: 'c1', code: 'K7P4QX', expires_at: '2026-10-29T14:10:00Z' };
  const found = { id: 'r1', name: 'Ievgen’s MacBook Pro', tools };
  const reduce = (events: Parameters<typeof pairingReducer>[1][], from: PairingState = pairingStart) => events.reduce(pairingReducer, from);

  it('issuing, then waiting with the server’s code, polling', () => {
    const s = reduce([{ type: 'issued', code: issued }]);
    expect(s).toMatchObject({ phase: 'waiting', code: 'K7P4QX' });
    expect(shouldPoll(s)).toBe(true);
    expect(shouldPoll(pairingStart)).toBe(false);
  });
  it('waiting stays waiting while the server says waiting', () => {
    expect(reduce([{ type: 'issued', code: issued }, { type: 'polled', poll: { status: 'waiting', expires_at: issued.expires_at } }]).phase).toBe('waiting');
  });
  it('connected carries the machine and the tools it FOUND, with the first installed tool selected', () => {
    const s = reduce([{ type: 'issued', code: issued }, { type: 'polled', poll: { status: 'connected', expires_at: issued.expires_at, runner: found } }]);
    expect(s).toMatchObject({ phase: 'connected', tool: 'claude-code', runner: { name: 'Ievgen’s MacBook Pro' } });
    expect(canPressDone(s)).toBe(true);
  });
  it('"connected" with no Runner in the answer is not believed', () => {
    expect(reduce([{ type: 'issued', code: issued }, { type: 'polled', poll: { status: 'connected', expires_at: issued.expires_at } }]).phase).toBe('waiting');
  });
  it('only a tool the Runner found can be chosen', () => {
    const base = reduce([{ type: 'issued', code: issued }, { type: 'polled', poll: { status: 'connected', expires_at: '', runner: found } }]);
    expect(reduce([{ type: 'choose_tool', tool: 'cursor' }], base)).toMatchObject({ tool: 'cursor' });
    expect(reduce([{ type: 'choose_tool', tool: 'codex' }], base)).toMatchObject({ tool: 'claude-code' });
    expect(pickableTools([{ id: 'cursor', installed: false }, { id: 'claude-code', installed: true }]).map((t) => t.id)).toEqual(['claude-code']);
    expect(defaultTool([{ id: 'cursor', installed: false }])).toBeNull();
  });
  it('Done is only possible with a chosen tool, and "connected" is NOT "on": only the server’s answer to Done reaches done', () => {
    const noTools = reduce([{ type: 'issued', code: issued }, { type: 'polled', poll: { status: 'connected', expires_at: '', runner: { ...found, tools: [] } } }]);
    expect(canPressDone(noTools)).toBe(false);
    expect(reduce([{ type: 'activate' }], noTools).phase).toBe('connected');
    const base = reduce([{ type: 'issued', code: issued }, { type: 'polled', poll: { status: 'connected', expires_at: '', runner: found } }]);
    const act = reduce([{ type: 'activate' }], base);
    expect(act.phase).toBe('activating');
    expect(canPressDone(act)).toBe(false); // no double press
    expect(reduce([{ type: 'activated', runnerId: 'r1', runnerName: 'M', tool: 'claude-code' }], act).phase).toBe('done');
    expect(reduce([{ type: 'activated', runnerId: 'r1', runnerName: 'M', tool: 'claude-code' }], base).phase).toBe('connected'); // never skips Done
  });
  it('a failed Done stays on the choice and says why; an expired window ends it', () => {
    const act = reduce([{ type: 'issued', code: issued }, { type: 'polled', poll: { status: 'connected', expires_at: '', runner: found } }, { type: 'activate' }]);
    expect(reduce([{ type: 'activate_failed', message: 'Nope' }], act)).toMatchObject({ phase: 'connected', error: 'Nope', tool: 'claude-code' });
    expect(reduce([{ type: 'activate_failed', message: 'x', expired: true }], act).phase).toBe('expired');
  });
  it('expired and cancelled come from the server’s poll; Cancel ends it from anywhere before Done and after Done does nothing', () => {
    const w = reduce([{ type: 'issued', code: issued }]);
    expect(reduce([{ type: 'polled', poll: { status: 'expired', expires_at: '' } }], w).phase).toBe('expired');
    expect(reduce([{ type: 'polled', poll: { status: 'cancelled', expires_at: '' } }], w).phase).toBe('cancelled');
    expect(reduce([{ type: 'cancel' }], w).phase).toBe('cancelled');
    const done: PairingState = { phase: 'done', runnerId: 'r', runnerName: 'M', tool: 't' };
    expect(reduce([{ type: 'cancel' }], done)).toBe(done);
    expect(shouldPoll(reduce([{ type: 'cancel' }], w))).toBe(false);
  });
  it('a failure to get a code is shown, not a blank card', () => {
    expect(reduce([{ type: 'issue_failed', message: 'Too many pairing codes' }])).toEqual({ phase: 'failed', message: 'Too many pairing codes' });
  });
  it('the code is shown as two groups of three and read out one character at a time', () => {
    expect(displayCode('K7P4QX')).toBe('K7P 4QX');
    expect(displayCode('k7p-4qx')).toBe('K7P 4QX');
    expect(codeAriaLabel('K7P4QX')).toBe('Pairing code K 7 P 4 Q X');
  });
});

describe('Remove, the first-time moment and the sidebar number', () => {
  it('the Remove confirm is Dara’s sentence, names the agent that waits, is danger, and is honest with none', () => {
    expect(confirmRemoveRunner('Ievgen’s MacBook Pro', ['Onboarding Assistant'])).toEqual({
      title: 'Remove Ievgen’s MacBook Pro?',
      message: 'Onboarding Assistant waits until you add another Runner. Nothing is deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    expect(removeConfirmMessage([])).toBe('Its agents wait until you add another Runner. Nothing is deleted.');
    expect(removeConfirmMessage(['A', 'B'])).toBe('A, B wait until you add another Runner. Nothing is deleted.');
    expect(COPY.removeRow).toBe('Its agents wait until you add another Runner. Nothing is deleted.');
  });
  it('the pinned copy is exactly Dara’s', () => {
    expect(COPY.doneSentence).toBe('Press Done to let this computer run your agents. Until then it is connected but does nothing.');
    expect(COPY.firstRun).toBe(
      'It thinks with an AI you already pay for: your own Claude Code or Cursor, through a small free Runner on your computer. Setting it up takes about two minutes.',
    );
    expect(COPY.command).toBe('npx @storyos/runner');
  });
  it('the Done toast never claims a record that was already waiting starts', () => {
    expect(readyToast('M', ['Onboarding Assistant'])).toBe('M is ready. New work for Onboarding Assistant now wakes it.');
    expect(readyToast('M', [])).toBe('M is ready.');
    for (const t of [readyToast('M', ['A']), readyToast('M', ['A', 'B'])]) expect(t).not.toMatch(/starts|starting|already/i);
  });
  it('the sidebar number is the server’s count of agents that cannot run; zero and "not loaded" draw nothing', () => {
    expect(cannotRunCount({ agents_that_cannot_run: 1 })).toBe(1);
    expect(cannotRunCount({ agents_that_cannot_run: 0 })).toBeNull();
    expect(cannotRunCount(undefined)).toBeNull();
  });
  it('how many are waiting comes from the summary for THAT agent; a missing summary is not a zero', () => {
    const s: WakeSummary = { agents: [{ agent_id: 'a1', name: 'A', runner: null, can_run: false, waiting: 3 }], waiting_total: 3, agents_that_cannot_run: 1 };
    expect(summaryFor(s, 'a1')?.waiting).toBe(3);
    expect(summaryFor(s, 'zzz')).toBeUndefined();
    expect(summaryFor(undefined, 'a1')).toBeUndefined();
    expect(waitingLine(1)).toBe('1 record is waiting for it');
    expect(waitingLine(3)).toBe('3 records are waiting for it');
  });
});

describe('agents, as read from their record', () => {
  const fields = [
    { apiName: 'ai_mode', options: [{ id: 'm1', label: 'Non-AI' }, { id: 'm2', label: 'Your own AI' }, { id: 'm3', label: 'StoryOS AI' }] },
    { apiName: 'approval_policy', options: [{ id: 'p1', label: 'email' }, { id: 'p2', label: 'outward' }] },
  ];
  const rec = (values: Record<string, unknown>) => ({ id: 'a1', title: 'Onboarding Assistant', created_by: 'me', values });
  it('only an ENABLED "Your own AI" agent is served by a Runner', () => {
    expect(toAgentView(rec({ ai_mode: 'm2', enabled: true }), fields).usesRunner).toBe(true);
    expect(toAgentView(rec({ ai_mode: 'm2', enabled: false }), fields).usesRunner).toBe(false);
    expect(toAgentView(rec({ ai_mode: 'm3', enabled: true }), fields).usesRunner).toBe(false);
    expect(toAgentView(rec({ enabled: true }), fields).usesRunner).toBe(false);
  });
  it('reads the owner, the job and what it asks before', () => {
    const a = toAgentView(rec({ ai_mode: 'm2', enabled: true, approval_policy: ['p1', 'p2', 'gone'], goal: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft a packet.' }] }] }), fields);
    expect(a).toMatchObject({ ownerId: 'me', job: 'Draft a packet.', asksBefore: ['email', 'outward'] });
  });
});

describe('words', () => {
  it('names tools, falling back to what the Runner called them', () => {
    expect(toolName('claude-code')).toBe('Claude Code');
    expect(toolName('cursor')).toBe('Cursor');
    expect(toolName('weird', [{ id: 'weird', name: 'Weird AI', installed: true }])).toBe('Weird AI');
    expect(toolName('weird')).toBe('weird');
    expect(limitBrand('claude-code')).toBe('Claude');
    expect(limitBrand('cursor')).toBe('Cursor');
  });
  it('formats times on the viewer’s clock and never in the future', () => {
    expect(clockTime('2026-10-29T18:40:00Z', TZ)).toBe('18:40');
    expect(shortDate('2026-10-29T18:40:00Z', TZ)).toBe('29 Oct');
    expect(checkedAgo('2026-10-29T13:59:50Z', NOW)).toBe('just now');
    expect(checkedAgo('2026-10-29T13:58:00Z', NOW)).toBe('2 minutes ago');
    expect(checkedAgo('2026-10-29T14:05:00Z', NOW)).toBe('just now');
  });
  it('says who a Runner runs', () => {
    expect(agentsLine([])).toBe('runs no agents yet');
    expect(agentsLine([{ name: 'A' }])).toBe('runs A');
    expect(agentsLine([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('runs A and 2 more');
  });
});

describe('who may open the Runner screens', () => {
  it('members and admins; never a guest, and not "unknown yet"', () => {
    expect(canUseRunners('admin')).toBe(true);
    expect(canUseRunners('member')).toBe(true);
    expect(canUseRunners('guest')).toBe(false);
    expect(canUseRunners(undefined)).toBe(false);
  });
});
