import { describe, expect, it } from 'vitest';
import { packPreviewItemSchema } from '@storyos/schemas';
import {
  automationSentence,
  automationState,
  installedAutomationState,
  enableAutomationsBody,
  enableAutomationsList,
  type AutomationPreviewItem,
} from './pack-automation-state';
import { buildInstallRows } from './pack-install-rows';

// Rules shaped like Social Command Center's preview ("Database.Rule name" labels, as the API builds them).
const email: AutomationPreviewItem = {
  name: 'Posts.Email me when a post is approved',
  enabled_on_install: false,
  switched_off_because: 'outward',
};
const agent: AutomationPreviewItem = {
  name: 'Posts.Draft a caption',
  enabled_on_install: false,
  switched_off_because: 'agent',
};
const internal: AutomationPreviewItem = { name: 'Posts.Stamp the approval date', enabled_on_install: true };
const existing: AutomationPreviewItem = { name: 'Posts.Already here' };
const shippedOff: AutomationPreviewItem = { name: 'Posts.Shipped off', enabled_on_install: false };

describe('automationState', () => {
  it('a rule that installs off for what it does is off and can be turned on', () => {
    expect(automationState(email, false)).toEqual({ kind: 'off', because: 'outward' });
    expect(automationState(agent, false)).toEqual({ kind: 'off', because: 'agent' });
  });
  it('an internal rule is on, with nothing to toggle', () => {
    expect(automationState(internal, false)).toEqual({ kind: 'on' });
  });
  it('a rule that already exists carries neither flag and says nothing new', () => {
    expect(automationState(existing, false)).toEqual({ kind: 'existing' });
    expect(automationSentence(automationState(existing, true))).toBeNull();
  });
  it('a rule the pack itself ships off (Social Command Center\'s reminders) is off with no reason from the API, and can be turned on', () => {
    expect(automationState(shippedOff, false)).toEqual({ kind: 'off', because: undefined });
    expect(automationState(shippedOff, true)).toEqual({ kind: 'turned-on', because: undefined });
  });
  it('turning it on reads on, and reads on while the server has not answered yet', () => {
    expect(automationState(email, true)).toEqual({ kind: 'turned-on', because: 'outward' });
  });
  it('the server confirming the choice keeps it on', () => {
    expect(automationState(email, true, { name: email.name, enabled_on_install: true }).kind).toBe('turned-on');
  });
  it('the server NOT confirming the choice (a label it ignored) shows off again, never on', () => {
    expect(automationState(email, true, { name: email.name, enabled_on_install: false }).kind).toBe('off');
  });
});

describe('automationSentence', () => {
  it('says why in plain words for each reason, never the API words', () => {
    const out = automationSentence(automationState(email, false))!;
    expect(out).toEqual({ lead: 'Off until you turn it on', rest: 'It sends things outside your workspace.' });
    const ag = automationSentence(automationState(agent, false))!;
    expect(ag).toEqual({ lead: 'Off until you turn it on', rest: 'It runs an agent.' });
    for (const s of [out, ag]) expect(`${s.lead} ${s.rest}`).not.toMatch(/outward|switched_off/);
  });
  it('a rule the pack ships off says so', () => {
    expect(automationSentence({ kind: 'off' })!.rest).toBe('The pack ships it switched off.');
  });
  it('on and turned-on both say On once installed; turned-on keeps the reason', () => {
    expect(automationSentence({ kind: 'on' })).toEqual({ lead: 'On once installed', rest: null });
    expect(automationSentence({ kind: 'turned-on' })!.rest).toBe('You turned it on.');
    expect(automationSentence({ kind: 'turned-on', because: 'agent' })).toEqual({
      lead: 'On once installed',
      rest: 'You turned it on: it runs an agent.',
    });
  });
});

describe('enableAutomationsList', () => {
  const items = [email, agent, internal, existing];
  it('is empty by default, and the body then omits the key entirely', () => {
    expect(enableAutomationsList(items, {})).toEqual([]);
    expect(enableAutomationsBody([])).toEqual({});
  });
  it('puts the chosen label in, exactly as the preview lists it', () => {
    expect(enableAutomationsList(items, { [email.name]: true })).toEqual(['Posts.Email me when a post is approved']);
    expect(enableAutomationsBody(['a'])).toEqual({ enable_automations: ['a'] });
  });
  it('a switch turned back off leaves the list', () => {
    expect(enableAutomationsList(items, { [email.name]: false, [agent.name]: true })).toEqual([agent.name]);
  });
  it('sends the label of a rule the pack ships off when the person turns it on', () => {
    expect(enableAutomationsList([shippedOff], { [shippedOff.name]: true })).toEqual([shippedOff.name]);
  });
  it('never sends a label for a rule that is already on, already exists, or is not in the preview', () => {
    const chosen = { [internal.name]: true, [existing.name]: true, 'Nope.Nothing': true };
    expect(enableAutomationsList(items, chosen)).toEqual([]);
  });
  it('does not list a rule the preview already shows on, even if a reason lingers', () => {
    const on = { name: 'Posts.On already', enabled_on_install: true, switched_off_because: 'outward' as const };
    expect(enableAutomationsList([on], { [on.name]: true })).toEqual([]);
  });
  it('the label equals the API format Database.Rule name, as built from the manifest, and the row carries the flags', () => {
    const rows = buildInstallRows(
      { databases: [], views: [], agents: [], automations: [{ ...email, action: 'create' }] },
      { automations: [{ database: 'Posts', name: 'Email me when a post is approved' }] },
    );
    const row = rows[0]!;
    expect(row.key).toBe('Posts.Email me when a post is approved');
    expect(row.item.enabled_on_install).toBe(false);
    expect(row.item.switched_off_because).toBe('outward');
    expect(enableAutomationsList([row.item], { [row.key]: true })).toEqual([row.key]);
  });
});

describe('the API contract this reads', () => {
  it('the schema package still emits the two fields under these names, with these reasons', () => {
    const parsed = packPreviewItemSchema.parse({
      name: 'Posts.Email me',
      action: 'create',
      enabled_on_install: false,
      switched_off_because: 'outward',
    });
    expect(parsed.enabled_on_install).toBe(false);
    expect(parsed.switched_off_because).toBe('outward');
    expect(packPreviewItemSchema.safeParse({ name: 'x', action: 'create', switched_off_because: 'sms' }).success).toBe(false);
  });
});

describe('installedAutomationState (the result screen)', () => {
  it('says on or off from what the install actually created, with the reason', () => {
    expect(installedAutomationState({ enabled: true })).toEqual({ kind: 'on' });
    expect(installedAutomationState({ enabled: false, switched_off_because: 'agent' })).toEqual({ kind: 'off', because: 'agent' });
    expect(installedAutomationState({ enabled: false })).toEqual({ kind: 'off', because: undefined });
  });
  it('says nothing when the API did not say (never guesses on)', () => {
    expect(installedAutomationState({})).toEqual({ kind: 'existing' });
  });
});
