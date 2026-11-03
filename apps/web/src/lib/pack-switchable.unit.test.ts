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
  type SwitchKinds,
  type SwitchableItem,
} from './pack-switchable';
import type { AutomationPreviewItem } from './pack-automation-state';

const email: AutomationPreviewItem = { name: 'Posts.Email me', enabled_on_install: false, switched_off_because: 'outward' };
const stamp: AutomationPreviewItem = { name: 'Posts.Stamp', enabled_on_install: true };

// A STAND-IN for ticket #1192's agent trigger. It is NOT registered in the product (the API does not return it yet); it exists
// here only to prove a second kind goes through the same row and request code with its own words and its own request field.
const trigger: AutomationPreviewItem = { name: 'Onboarding Assistant', enabled_on_install: false };
const KINDS: SwitchKinds = {
  ...SWITCH_KINDS,
  agent_trigger: {
    requestField: 'enable_agent_triggers',
    sentence: (state) =>
      state.kind === 'off'
        ? { lead: 'Off', rest: 'Wakes when Status becomes Onboarding.' }
        : state.kind === 'turned-on'
          ? { lead: 'On once installed', rest: 'Wakes when Status becomes Onboarding.' }
          : null,
    ariaLabel: (key) => `Let ${key} wake itself when installed`,
    pick: (items, chosen) => items.filter((i) => i.enabled_on_install === false && chosen[i.name]).map((i) => i.name),
  },
};

const row = (kind: string, item: AutomationPreviewItem, chosen = false) =>
  renderToStaticMarkup(createElement(SwitchableRow, { kind, item, chosen, onChoose: () => {}, kinds: KINDS }));

describe('the registry today', () => {
  it('knows automations only: agent triggers are not registered until the API returns them (ticket #1192)', () => {
    expect(Object.keys(SWITCH_KINDS)).toEqual(['automation']);
    expect(SWITCH_KINDS.automation!.requestField).toBe('enable_automations');
  });
});

describe('enableRequestBody', () => {
  const items: SwitchableItem[] = [...automationItems([email, stamp]), { kind: 'agent_trigger', key: trigger.name, item: trigger }];
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
      enable_agent_triggers: ['Onboarding Assistant'],
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
  it('with the product registry, a second kind is unknown and is not sent under a guessed field', () => {
    const chosen = { [switchId('agent_trigger', trigger.name)]: true };
    expect(enableRequestBody(items, chosen)).toEqual({});
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
    expect(html).toContain('Wakes when Status becomes Onboarding.');
    expect(html).not.toContain('Off until you turn it on');
    expect(html).toContain('aria-label="Let Onboarding Assistant wake itself when installed"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });
  it('a second kind turned on reads checked and uses its own on-sentence', () => {
    const html = row('agent_trigger', trigger, true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('On once installed');
  });
  it('an unknown kind draws nothing and does not throw', () => {
    expect(row('mystery', trigger)).toBe('');
    expect(switchableSentence('mystery', trigger, false, undefined, KINDS)).toBeNull();
  });
  it('an item that already exists draws nothing, whatever its kind', () => {
    expect(row('agent_trigger', { name: 'Existing' })).toBe('');
  });
});
