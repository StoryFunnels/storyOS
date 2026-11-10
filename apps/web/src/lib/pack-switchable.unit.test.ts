import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwitchableRow } from '@/components/pack-automation-state';
import {
  SWITCH_KINDS,
  automationItems,
  enableRequestBody,
  switchId,
  switchableSentence,
  parseTriggerLabel,
  triggerItems,
  triggersOfAgent,
  type SwitchKinds,
  type SwitchableItem,
} from './pack-switchable';
import type { AutomationPreviewItem } from './pack-automation-state';

const email: AutomationPreviewItem = { name: 'Posts.Email me', enabled_on_install: false, switched_off_because: 'outward' };
const stamp: AutomationPreviewItem = { name: 'Posts.Stamp', enabled_on_install: true };

// Ticket #1254 — the real agent-trigger kind, with the labels and flags the preview's `triggers` list carries.
const LABEL = 'Triage \u2190 Issues.Status = Onboarding';
const trigger: AutomationPreviewItem = { name: LABEL, enabled_on_install: false, switched_off_because: 'wakes_agent' };
const gated: AutomationPreviewItem = { name: 'Triage \u2190 Issues.Status = Review', enabled_on_install: true };
const KINDS: SwitchKinds = SWITCH_KINDS;

const row = (kind: string, item: AutomationPreviewItem, chosen = false) =>
  renderToStaticMarkup(createElement(SwitchableRow, { kind, item, chosen, onChoose: () => {}, kinds: KINDS }));

describe('the registry', () => {
  it('knows automations and agent triggers, each with its own request field (ticket #1254)', () => {
    expect(Object.keys(SWITCH_KINDS)).toEqual(['automation', 'agent_trigger']);
    expect(SWITCH_KINDS.automation!.requestField).toBe('enable_automations');
    expect(SWITCH_KINDS.agent_trigger!.requestField).toBe('enable_agent_triggers');
  });
  it('parses a label and refuses a shape it does not know', () => {
    expect(parseTriggerLabel(LABEL)).toEqual({ agent: 'Triage', database: 'Issues', field: 'Status', option: 'Onboarding' });
    expect(parseTriggerLabel('Onboarding Assistant')).toBeNull();
  });
  it('triggersOfAgent keeps exactly the triggers of that agent, and not a prefix-sharing one', () => {
    const list = [trigger, gated, { name: 'Triage Two \u2190 Issues.Status = Onboarding' }];
    expect(triggersOfAgent(list, 'Triage').map((t) => t.name)).toEqual([trigger.name, gated.name]);
    expect(triggersOfAgent(list, 'Nobody')).toEqual([]);
  });
});

describe('enableRequestBody', () => {
  const items: SwitchableItem[] = [...automationItems([email, stamp]), ...triggerItems([trigger, gated])];
  it('is empty by default', () => {
    expect(enableRequestBody(items, {}, KINDS)).toEqual({});
  });
  it('automations keep going in enable_automations, under the preview label', () => {
    expect(enableRequestBody(items, { [switchId('automation', email.name)]: true }, KINDS)).toEqual({
      enable_automations: ['Posts.Email me'],
    });
  });
  it('a second kind goes in its own field, built by the same function', () => {
    const chosen = { [switchId('automation', email.name)]: true, [switchId('agent_trigger', trigger.name)]: true };
    expect(enableRequestBody(items, chosen, KINDS)).toEqual({
      enable_automations: ['Posts.Email me'],
      enable_agent_triggers: [LABEL],
    });
  });
  it('the same label under two kinds cannot collide: a choice is per kind', () => {
    const same: SwitchableItem[] = [
      { kind: 'automation', key: 'X', item: { name: 'X', enabled_on_install: false, switched_off_because: 'agent' } },
      { kind: 'agent_trigger', key: 'X', item: { name: 'X', enabled_on_install: false } },
    ];
    expect(enableRequestBody(same, { [switchId('agent_trigger', 'X')]: true }, KINDS)).toEqual({ enable_agent_triggers: ['X'] });
  });
  it('an unknown kind is ignored: nothing sent, no crash, the known kinds still work', () => {
    const odd: SwitchableItem[] = [{ kind: 'mystery', key: 'M', item: { name: 'M', enabled_on_install: false } }, ...automationItems([email])];
    const chosen = { [switchId('mystery', 'M')]: true, [switchId('automation', email.name)]: true };
    expect(enableRequestBody(odd, chosen, KINDS)).toEqual({ enable_automations: ['Posts.Email me'] });
  });
  it('a trigger left off sends nothing: default off, nothing chosen', () => {
    expect(enableRequestBody(items, {})).toEqual({});
  });
  it('a human-gated trigger (never held off) is never sent, even when chosen', () => {
    expect(enableRequestBody(items, { [switchId('agent_trigger', gated.name)]: true })).toEqual({});
  });
  it('a trigger that already exists (no flags) is never sent, even when chosen', () => {
    const existing = triggerItems([{ name: 'Triage \u2190 Issues.Status = Done' }]);
    expect(enableRequestBody(existing, { [switchId('agent_trigger', 'Triage \u2190 Issues.Status = Done')]: true })).toEqual({});
  });
});

describe('SwitchableRow: one row, per-kind words', () => {
  it('an automation renders exactly as before', () => {
    const html = row('automation', email);
    expect(html).toContain('Off until you turn it on');
    expect(html).toContain('It sends things outside your workspace.');
    expect(html).toContain('data-kind="automation"');
    expect(html).toContain('aria-label="Turn on Posts.Email me when installed"');
  });
  it('a second kind renders through the same row, with its own wording and its own aria label', () => {
    const html = row('agent_trigger', trigger);
    expect(html).toContain('data-testid="pack-automation-state"');
    expect(html).toContain('data-kind="agent_trigger"');
    expect(html).toContain('Wake it automatically');
    expect(html).toContain('Off until you turn it on. Wakes when Status becomes Onboarding.');
    expect(html).toContain('aria-label="Wake Triage automatically when Status becomes Onboarding"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });
  it('a second kind turned on reads checked and uses its own on-sentence', () => {
    const html = row('agent_trigger', trigger, true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('On once installed. Wakes when Status becomes Onboarding.');
  });
  it('a human-gated trigger draws nothing: it never wakes by itself, so there is nothing to switch', () => {
    expect(row('agent_trigger', gated)).toBe('');
  });
  it('an unknown kind draws nothing and does not throw', () => {
    expect(row('mystery', trigger)).toBe('');
    expect(switchableSentence('mystery', trigger, false, undefined, KINDS)).toBeNull();
  });
  it('an item that already exists draws nothing, whatever its kind', () => {
    expect(row('agent_trigger', { name: 'Existing' })).toBe('');
  });
});
