import { describe, expect, it } from 'vitest';
import type { PackDatabaseGains } from '@storyos/schemas';
import { gainsSentences, itemEffect, releaseNotes, versionsBetween, type PackVersion } from './pack-update';

const v = (version: string, changelog?: string): PackVersion => ({
  version,
  changelog,
  published_at: '2026-10-01T00:00:00Z',
});

describe('versionsBetween (#978)', () => {
  const all = [v('1.0'), v('1.1'), v('1.4'), v('1.5'), v('1.10')];
  it('returns the versions an update crosses, newest first, excluding the installed one', () => {
    expect(versionsBetween(all, '1.1', '1.5').map((x) => x.version)).toEqual(['1.5', '1.4']);
  });
  it('compares dotted numbers, not text: 1.10 is after 1.9', () => {
    expect(versionsBetween([v('1.9'), v('1.10')], '1.9', '1.10').map((x) => x.version)).toEqual([
      '1.10',
    ]);
  });
  it('excludes versions beyond the target', () => {
    expect(versionsBetween(all, '1.4', '1.5').map((x) => x.version)).toEqual(['1.5']);
  });
  it('is empty when nothing is newer', () => {
    expect(versionsBetween(all, '1.10', '1.10')).toEqual([]);
  });
});

describe('releaseNotes', () => {
  it('splits the newest version from the earlier ones it skipped over', () => {
    const n = releaseNotes([v('1.4', 'four'), v('1.5', 'five'), v('1.3', 'old')], '1.3', '1.5');
    expect(n.latest?.version).toBe('1.5');
    expect(n.earlier.map((x) => x.version)).toEqual(['1.4']);
    expect(n.noNotes).toBe(false);
  });
  it('says there are no notes when every crossed version is blank or missing a changelog', () => {
    expect(releaseNotes([v('1.5'), v('1.4', '   ')], '1.3', '1.5').noNotes).toBe(true);
  });
  it('a built-in pack has no version data at all: no latest, no notes', () => {
    const n = releaseNotes(undefined, '1.0', '1.1');
    expect(n).toEqual({ latest: null, earlier: [], noNotes: true });
  });
  it('still has notes when only an earlier version wrote one', () => {
    expect(releaseNotes([v('1.5'), v('1.4', 'only this')], '1.3', '1.5').noNotes).toBe(false);
  });
});

describe('itemEffect: states what install does today', () => {
  const gains = (over: Partial<PackDatabaseGains> = {}): PackDatabaseGains => ({
    fields: [],
    options: [],
    views: [],
    not_applied: [],
    ...over,
  });

  it('a NEW item carries no note at all: the dialog says "All new" once instead of per row', () => {
    for (const k of ['database', 'view', 'automation', 'agent'] as const)
      expect(itemEffect(k, 'create')).toBeNull();
  });
  it('an agent with no agent_update (not made by an earlier install of this pack) is left exactly as it is', () => {
    expect(itemEffect('agent', 'reuse')).toBe('Already yours — left exactly as it is.');
  });
  it('a reused view or automation is left alone', () => {
    expect(itemEffect('view', 'reuse')).toBe('Already there — kept as it is.');
    expect(itemEffect('automation', 'reuse')).toBe('Already there — kept as it is.');
  });
  it('a reused database names the fields it gains, from the preview', () => {
    const g = gains({
      fields: [
        { name: 'Health', type: 'select' },
        { name: 'Industry', type: 'text' },
        { name: 'Monthly Value', type: 'number' },
      ],
    });
    expect(itemEffect('database', 'reuse', g)).toBe(
      'Already in your workspace — kept as it is. Adds 3 fields it needs: Health, Industry, Monthly Value.',
    );
  });
  it('one gained field reads as a field, not "1 fields"', () => {
    expect(itemEffect('database', 'reuse', gains({ fields: [{ name: 'Budget', type: 'number' }] }))).toMatch(
      /Adds the Budget field\./,
    );
  });
  it('says so when a reused database gains nothing, rather than staying silent', () => {
    expect(itemEffect('database', 'reuse', gains())).toBe(
      'Already in your workspace — kept as it is. Nothing to add.',
    );
  });
  it('names added options and views', () => {
    const g = gains({ options: [{ field: 'Status', labels: ['Won', 'Lost'] }], views: ['Board'] });
    expect(gainsSentences(g)).toEqual(['Adds Won and Lost to Status.', 'Adds the Board view.']);
  });
  it('says what it will NOT apply, with the reason, and does not soften a blocker', () => {
    const g = gains({
      not_applied: [
        { kind: 'field', name: 'Priority', reason: 'it exists as a number' },
        { kind: 'state', name: 'Stage', reason: 'it is not a select', blocks_install: true },
      ],
    });
    expect(gainsSentences(g)).toEqual([
      'Not applied: Priority — it exists as a number',
      'Can’t install: Stage — it is not a select',
    ]);
  });
  it('a database collision says nothing of yours is removed, and still reports what it adds', () => {
    const g = gains({ fields: [{ name: 'Budget', type: 'number' }] });
    const s = itemEffect('database', 'collision', g)!;
    expect(s).toMatch(/nothing in it is removed/);
    expect(s).toMatch(/Adds the Budget field/);
  });
  it('a non-database collision hands the choice to the person', () => {
    expect(itemEffect('view', 'collision')).toMatch(/You choose/);
  });
  it('never offers Keep mine / Take update: those live in agentEffect', () => {
    for (const k of ['database', 'view', 'automation', 'agent'] as const)
      for (const a of ['create', 'reuse', 'collision'] as const)
        expect(itemEffect(k, a) ?? '').not.toMatch(/keep mine|take update/i);
  });
});

import type { PackAgentUpdate } from '@storyos/schemas';
import {
  agentEffect,
  agentResolutions,
  changedFieldsText,
  changesWhatItMayDo,
} from './pack-update';

const upd = (over: Partial<PackAgentUpdate>): PackAgentUpdate => ({
  status: 'will_update',
  changed_fields: ['instructions'],
  ...over,
});

describe('#978 AC3 — agent effects come from the preview API', () => {
  it('will_update says it will be updated and names what changes', () => {
    const e = agentEffect(upd({ status: 'will_update', changed_fields: ['goal', 'instructions'] }));
    expect(e.headline).toBe(
      'Agent: will be updated to this version (goal and instructions change).',
    );
    expect(e.needsChoice).toBe(false);
  });

  it('unchanged says there is nothing to do', () => {
    expect(agentEffect(upd({ status: 'unchanged', changed_fields: [] })).headline).toMatch(
      /already matches/,
    );
  });

  it('edited_needs_choice asks, and says why for an edit and for an unknown origin', () => {
    const edited = agentEffect(upd({ status: 'edited_needs_choice', reason: 'edited' }));
    expect(edited.needsChoice).toBe(true);
    expect(edited.headline).toMatch(/You’ve changed this agent/);
    expect(edited.detail).toMatch(/differs in its instructions/);
    const legacy = agentEffect(upd({ status: 'edited_needs_choice', reason: 'unknown_origin' }));
    expect(legacy.detail).toMatch(/installed before changes were tracked/);
    expect(legacy.detail).toMatch(/your version is kept/);
  });

  it('a proposed AI mode is a choice that states current and proposed, and warns when it is metered (ticket #1106)', () => {
    const e = agentEffect(
      upd({ status: 'edited_needs_choice', reason: 'ai_mode', ai_mode_change: { current: null, proposed: 'storyos_ai' } }),
    );
    expect(e.needsChoice).toBe(true);
    expect(e.headline).toContain('not set → StoryOS AI');
    expect(e.detail).toMatch(/StoryOS AI is metered/);
    expect(e.detail).toMatch(/only changes if you take the update/);
    const own = agentEffect(upd({ status: 'edited_needs_choice', reason: 'ai_mode', ai_mode_change: { current: 'non_ai', proposed: 'your_own_ai' } }));
    expect(own.headline).toContain('Non-AI → Your own AI');
    expect(own.detail).not.toMatch(/metered/);
  });

  it('lists changed fields in plain words, and calls out the ones that change what the agent may do', () => {
    expect(changedFieldsText(['instructions', 'scopes', 'approval_policy'])).toBe(
      'instructions, what it may access and when it asks for approval',
    );
    expect(changedFieldsText(['goal'])).toBe('goal');
    expect(changesWhatItMayDo(['goal', 'instructions'])).toBe(false);
    expect(changesWhatItMayDo(['scopes'])).toBe(true);
    expect(changesWhatItMayDo(['approval_policy'])).toBe(true);
  });
});

describe('#978 AC3 — only an explicit "Take update" on an edited agent becomes a resolution', () => {
  const agents = [
    { name: 'Triage', agent_update: upd({ status: 'edited_needs_choice' }) },
    { name: 'Digest', agent_update: upd({ status: 'will_update' }) },
    { name: 'Plain' },
    { name: 'Same', agent_update: upd({ status: 'unchanged', changed_fields: [] }) },
  ];

  it('defaults to Keep mine: no choices means no resolutions at all', () => {
    expect(agentResolutions(agents, {})).toEqual({});
    expect(agentResolutions(agents, { Triage: 'keep' })).toEqual({});
  });

  it('sends update for the edited agent the person chose to update', () => {
    expect(agentResolutions(agents, { Triage: 'update' })).toEqual({
      Triage: { action: 'update' },
    });
  });

  it('never sends update for an agent that is not edited_needs_choice (the API refuses it with a 422)', () => {
    expect(agentResolutions(agents, { Digest: 'update', Plain: 'update', Same: 'update' })).toEqual(
      {},
    );
  });
});
